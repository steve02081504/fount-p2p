import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'

import { base64ToBytes, bytesToBase64 } from '../../../core/bytes_codec.mjs'
import { isHex64 } from '../../../core/hexIds.mjs'
import { getDiscoveryProvider, sendNodeSignalPacket } from '../../../discovery/index.mjs'
import { NOSTR_SIGNAL_KIND, resolveNostrRelayUrls } from '../../../discovery/nostr/index.mjs'
import { ms } from '../../../utils/duration.mjs'
import { createLruMap } from '../../../utils/lru.mjs'
import { FRAME_HEADER_BYTES, maxFrameChunkBytesForPayload } from '../../frame.mjs'
import { asLinkHandle } from '../../pipe.mjs'
import { LINK_LEVEL_NOSTR } from '../levels.mjs'
import { createLinkIdBoundPipe } from '../link_id_pipe.mjs'

/** 单包 payload（UTF-8 / base64）上限，避免撞 relay content 限制。
 *  默认兜底取 2026-08 本机对默认公共 relay 的 NIP-11 `max_message_length` 非零最小值（131072 = nostr.mom）。
 *  有 relay 信息时用实测非零最小值覆盖（见 refreshPayloadCap），无 relay / 未探测到时用此默认。 */
export const MAX_LINK_PAYLOAD_CHARS = 131072

/** relay info（NIP-11）单次探测超时。 */
const RELAY_INFO_TIMEOUT_MS = ms('4s')
/** 实测 payload 上限缓存有效期。 */
const PAYLOAD_CAP_CACHE_TTL_MS = ms('10m')
const textEncoder = new TextEncoder()
/** 固定 64 位 hex 占位（id/pubkey/sig/rendezvousKey/nodeHash 均固定宽度）。 */
const HEX64 = 'a'.repeat(64)
/** AES-GCM 封装输出中的固定长度字段占位：iv = base64(12B) = 16，authTag = base64(16B) = 24。 */
const GCM_IV_BASE64 = 'a'.repeat(16)
const GCM_AUTH_TAG_BASE64 = 'a'.repeat(24)

/**
 * 估算把给定 link 包发布为 Nostr EVENT 后，完整 WebSocket 消息（["EVENT", event]）的 UTF-8 字节长度。
 * id/pubkey/sig/rendezvousKey/nodeHash 均为固定 64 hex，created_at/kind/tags 固定，故长度仅随 packet.payload 变化，
 * 可同步精确构造（含加密封装壳与 event 字段），无需真正 AES-GCM 封装与 Schnorr 签名。
 * @param {object} packet link 包
 * @returns {number} 完整消息字节长度
 */
export function estimateEventMessageBytes(packet) {
	// encryptSignalPacket 输出全 ASCII：{"iv":<16>,"authTag":<24>,"ciphertext":base64(packetJson bytes)}。
	return textEncoder.encode(JSON.stringify(['EVENT', {
		id: HEX64,
		pubkey: HEX64,
		created_at: Math.floor(Date.now() / 1000),
		kind: NOSTR_SIGNAL_KIND,
		tags: [['t', HEX64], ['x', 'signal'], ['p', HEX64]],
		content: bytesToBase64(textEncoder.encode(JSON.stringify({
			iv: GCM_IV_BASE64,
			authTag: GCM_AUTH_TAG_BASE64,
			ciphertext: bytesToBase64(textEncoder.encode(JSON.stringify(packet))),
		}))),
		sig: HEX64,
	}])).length
}

/** relay cap 低于此字符数视为无法承载最小正 chunk（帧头 + 1 字节 chunk 的完整 EVENT 封装），从统一上限中剔除。
 *  这类 relay 即便能传也无法携带有效载荷（maxFrameChunkBytesForPayload 得 0），参与取最小值只会无谓拖低/毒化整条链路。 */
export const MIN_USABLE_RELAY_CAP_CHARS = estimateEventMessageBytes({
	type: 'link',
	op: 'b',
	from: HEX64,
	linkId: HEX64,
	payload: bytesToBase64(new Uint8Array(FRAME_HEADER_BYTES + 1)),
})

/**
 * 拉取单个 relay 的 NIP-11 relay info 并读取 max_message_length。
 * @param {string} relayUrl relay URL
 * @returns {Promise<number | null>} 非零上限；失败/未声明返回 null
 */
async function queryRelayMaxMessageLength(relayUrl) {
	const httpUrl = relayUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), RELAY_INFO_TIMEOUT_MS)
	timer.unref?.()
	try {
		const response = await fetch(httpUrl, { headers: { Accept: 'application/nostr+json' }, signal: controller.signal })
		const info = await response.json()
		const limit = { ...info?.limit || {}, ...info?.limitation || {} }
		const value = Number(limit.max_message_length)
		return Number.isFinite(value) && value > 0 ? value : null
	}
	catch {
		return null
	}
	finally {
		clearTimeout(timer)
	}
}

/**
 * 从各 relay 上报的 cap 中取「可用」（>= 最小可用帧，能产生正数 chunk budget）的非零最小值。
 * cap 过低的 relay 无法承载最小正 chunk（完整 EVENT 封装装不下），取最小值只会拖低/毒化整条链路，故剔除；
 * 剩余 relay 的最小值保证任意一个可用 relay 都能传该帧（publishEvent 只要求任一 relay 接受）。
 * @param {Array<number | null | undefined>} caps 各 relay 上报的 cap
 * @returns {number | null} 可用最小值；无可用 relay 返回 null
 */
export function minUsablePayloadCap(caps) {
	const usable = caps.filter(value => Number.isFinite(value) && value >= MIN_USABLE_RELAY_CAP_CHARS)
	return usable.length ? Math.min(...usable) : null
}

/** open 到达前为同一 linkId 暂存的 c/b 包上限。 */
const PENDING_PACKETS_MAX = 32
/** Nostr 链握手超时（relay RTT 更慢）。 */
const NOSTR_HANDSHAKE_TIMEOUT_MS = ms('30s')
/** Nostr 链心跳间隔。 */
const NOSTR_HEARTBEAT_MS = ms('60s')
/** Nostr 链空闲超时。 */
const NOSTR_IDLE_TIMEOUT_MS = ms('3m')

/**
 * @param {string} remoteNodeHash 对端
 * @param {object} packet link 包
 * @returns {Promise<void>}
 */
async function publishLinkPacket(remoteNodeHash, packet) {
	await sendNodeSignalPacket(remoteNodeHash, packet)
}

/**
 * 创建 Nostr 末位数据链路 provider（level = -∞）。
 * @param {{ getRelayUrls?: () => string[] }} [options] 中继解析（测试可注入）
	 * @returns {import('./index.mjs').LinkProvider & { deliverPacket: (packet: object) => void | Promise<void> }} provider
 */
export function createNostrLinkProvider(options = {}) {
	const resolveRelayUrls = options.getRelayUrls || resolveNostrRelayUrls

	/** @type {number | null} 本实例实测非零最小 payload 上限（NIP-11 max_message_length） */
	let queriedPayloadCap = null
	/** @type {number} 本实例最近一次实测时间戳 */
	let payloadCapQueriedAt = 0
	/** @type {Promise<void> | null} 本实例进行中的探测（去重并发） */
	let payloadCapRefreshPromise = null

	/**
	 * 探测各 relay 的 payload 上限，缓存「可用 relay」的最小值（TTL 内不重复探测）。
	 * 仅在实际 wss/ws/https/http 中继上探测；失败或未声明的 relay 忽略。
	 * @param {string[]} relayUrls 中继 URL 列表
	 * @returns {Promise<void>}
	 */
	async function refreshPayloadCap(relayUrls) {
		if (payloadCapRefreshPromise) return payloadCapRefreshPromise
		if (queriedPayloadCap != null && Date.now() - payloadCapQueriedAt < PAYLOAD_CAP_CACHE_TTL_MS) return
		const urls = [...new Set(relayUrls.filter(url => /^(wss?|https?):\/\//i.test(url)))]
		if (!urls.length) return
		payloadCapRefreshPromise = Promise.allSettled(urls.map(queryRelayMaxMessageLength))
			.then(results => {
				const value = minUsablePayloadCap(results.map(result => result.status === 'fulfilled' ? result.value : null))
				if (value != null) {
					queriedPayloadCap = value
					payloadCapQueriedAt = Date.now()
				}
			})
			.finally(() => { payloadCapRefreshPromise = null })
		return payloadCapRefreshPromise
	}

	/**
	 * 当前生效的单包上限：有 relay 实测非零最小值则用它（最大化载荷利用率），否则用默认兜底。
	 * @returns {number} 上限（针对完整 Nostr EVENT 消息的字节数）
	 */
	function currentMaxPayloadChars() {
		return queriedPayloadCap ?? MAX_LINK_PAYLOAD_CHARS
	}

	/** @type {((link: import('./index.mjs').LinkHandle) => void) | null} */
	let onInbound = null
	/** @type {object | null} */
	let localIdentity = null
	/**
	 * @typedef {{
	 *   pipe: ReturnType<typeof createLinkIdBoundPipe>,
	 *   remoteNodeHash: string,
	 *   initiator: boolean,
	 * }} NostrLinkSession
	 */
	/** @type {Map<string, NostrLinkSession>} */
	const sessions = new Map()
	/** @type {Map<string, object[]> & { touch: (key: string, value: object[]) => void }} */
	const pendingByLinkId = createLruMap(64)

	/**
	 * @returns {boolean} discovery nostr 已注册且有中继
	 */
	function isAvailable() {
		if (!getDiscoveryProvider('nostr')) return false
		return resolveRelayUrls().length > 0
	}

	/**
	 * @param {NostrLinkSession} session 会话
	 * @param {object} packet link 包
	 * @returns {void}
	 */
	function applySessionPacket(session, packet) {
		const op = String(packet.op || '')
		if (op === 'close') {
			void session.pipe.close('remote-close')
			return
		}
		if (op === 'c') {
			if (typeof packet.payload !== 'string') return
			session.pipe.handleInbound(packet.payload)
			return
		}
		if (op === 'b') {
			if (typeof packet.payload !== 'string') return
			try {
				session.pipe.handleInbound(Buffer.from(base64ToBytes(packet.payload)))
			}
			catch { /* drop malformed */ }
		}
	}

	/**
	 * @param {string} linkId 链路 id
	 * @param {object} packet 暂存包
	 * @returns {void}
	 */
	function bufferPending(linkId, packet) {
		let list = pendingByLinkId.get(linkId)
		if (!list) {
			list = []
			pendingByLinkId.touch(linkId, list)
		}
		if (list.length >= PENDING_PACKETS_MAX) list.shift()
		list.push(packet)
	}

	/**
	 * @param {string} remoteNodeHash 对端
	 * @param {string} linkId 链路 id
	 * @param {string} op open|c|b|close
	 * @param {string} [payload] 可选载荷
	 * @param {number} [maxChars=MAX_LINK_PAYLOAD_CHARS] 该 pipe 冻结的字符上限
	 * @returns {Promise<void>}
	 */
	async function sendOp(remoteNodeHash, linkId, op, payload, maxChars = MAX_LINK_PAYLOAD_CHARS) {
		const packet = {
			type: 'link',
			op,
			from: localIdentity?.nodeHash || '',
			linkId,
		}
		if (payload != null) packet.payload = payload
		if (estimateEventMessageBytes(packet) > maxChars)
			throw new Error('p2p: nostr link payload too large')
		await publishLinkPacket(remoteNodeHash, packet)
	}

	/**
	 * @param {object} opts 会话选项
	 * @returns {ReturnType<typeof createLinkIdBoundPipe>} pipe
	 */
	function openPipe(opts) {
		const { linkId, remoteNodeHash, initiator } = opts
		// 冻结该 pipe 的字符上限：按完整 Nostr EVENT 消息字节数切帧，与发送校验共用同一上限，保持自洽。
		const payloadChars = currentMaxPayloadChars()
		const maxFrameBytes = maxFrameChunkBytesForPayload(
			payloadChars,
			// maxFrameChunkBytesForPayload 用 encode(...).length 度量载荷，故返回等长字符串。
			frameBytes => 'x'.repeat(estimateEventMessageBytes({
				type: 'link',
				op: 'b',
				from: (opts.localIdentity || localIdentity)?.nodeHash || '',
				linkId,
				payload: bytesToBase64(frameBytes),
			})),
		)
		const pipe = createLinkIdBoundPipe({
			providerId: 'nostr',
			level: LINK_LEVEL_NOSTR,
			initiator: !!initiator,
			linkId,
			nodeHash: remoteNodeHash,
			localIdentity: opts.localIdentity || localIdentity,
			maxFrameBytes,
			handshakeTimeoutMs: NOSTR_HANDSHAKE_TIMEOUT_MS,
			heartbeatMs: NOSTR_HEARTBEAT_MS,
			idleTimeoutMs: NOSTR_IDLE_TIMEOUT_MS,
			/**
			 * @param {string} text control JSON
			 * @returns {Promise<void>}
			 */
			async sendControlText(text) {
				await sendOp(remoteNodeHash, linkId, 'c', text, payloadChars)
			},
			/**
			 * @param {string} _action action
			 * @param {Uint8Array} frame 帧
			 * @returns {Promise<void>}
			 */
			async sendFrame(_action, frame) {
				await sendOp(remoteNodeHash, linkId, 'b', bytesToBase64(frame), payloadChars)
			},
			/**
			 * @returns {Promise<void>}
			 */
			async closeTransport() {
				sessions.delete(linkId)
				try {
					await sendOp(remoteNodeHash, linkId, 'close')
				}
				catch { /* ignore */ }
			},
		})
		sessions.set(linkId, { pipe, remoteNodeHash, initiator: !!initiator })
		pipe.onDown(() => { sessions.delete(linkId) })
		return pipe
	}

	/**
	 * 入站已解密的 link 包（由信令 demux 调用）。
	 * @param {object} packet link 包
	 * @returns {Promise<void>}
	 */
	async function deliverPacket(packet) {
		if (packet?.type !== 'link') return
		const linkId = packet.linkId
		const from = packet.from
		if (!isHex64(linkId) || !isHex64(from)) return
		if (localIdentity?.nodeHash && from === localIdentity.nodeHash) return

		const op = String(packet.op || '')
		if (op === 'open') {
			if (sessions.has(linkId)) return
			if (!onInbound || !localIdentity) return
			await refreshPayloadCap(resolveRelayUrls())
			if (sessions.has(linkId)) return
			const pipe = openPipe({
				linkId,
				remoteNodeHash: from,
				initiator: false,
				localIdentity,
			})
			onInbound(asLinkHandle(pipe))
			void pipe.startHandshake().catch(() => {
				sessions.delete(linkId)
				void pipe.close('accept-failed')
			})
			const pending = pendingByLinkId.get(linkId) || []
			pendingByLinkId.delete(linkId)
			const session = sessions.get(linkId)
			if (session)
				for (const queued of pending)
					applySessionPacket(session, queued)
			return
		}

		const session = sessions.get(linkId)
		if (!session) {
			if (op === 'c' || op === 'b' || op === 'close')
				bufferPending(linkId, packet)
			return
		}
		applySessionPacket(session, packet)
	}

	return {
		id: 'nostr',
		level: LINK_LEVEL_NOSTR,
		caps: { needsOfferAnswer: false, needsDiscoverySignal: false, probe: 'sync' },
		isAvailable,
		/**
		 * @returns {boolean} 有中继即可
		 */
		canReach() {
			return isAvailable()
		},
		deliverPacket,
		/**
		 * @param {object} dialOptions dial 选项
		 * @returns {Promise<import('./index.mjs').LinkHandle | null>} link
		 */
		async dial(dialOptions) {
			if (!isAvailable()) return null
			const remoteNodeHash = dialOptions.nodeHash
			if (!isHex64(remoteNodeHash)) return null
			localIdentity = dialOptions.localIdentity || localIdentity
			if (!localIdentity?.nodeHash) throw new Error('p2p: nostr dial requires localIdentity')
			await refreshPayloadCap(resolveRelayUrls())
			const linkId = randomBytes(32).toString('hex')
			const pipe = openPipe({
				linkId,
				remoteNodeHash,
				initiator: true,
				localIdentity,
			})
			await sendOp(remoteNodeHash, linkId, 'open')
			await pipe.startHandshake()
			return asLinkHandle(pipe)
		},
		/**
		 * @param {{ onInbound: (link: import('./index.mjs').LinkHandle) => void, localIdentity: object }} handlers 回调
		 * @returns {() => void} 停止 listening
		 */
		ensureListening(handlers) {
			onInbound = handlers.onInbound
			localIdentity = handlers.localIdentity
			// 探测延迟到启动路径之外（首个 macrotask），避免同步 fetch 阻塞 startup 预算。
			const capTimer = setTimeout(() => {
				let relayUrls
				try { relayUrls = resolveRelayUrls() } catch { return }
				void refreshPayloadCap(relayUrls).catch(() => { })
			}, 0)
			capTimer.unref?.()
			return () => {
				clearTimeout(capTimer)
				onInbound = null
				for (const session of sessions.values())
					void session.pipe.close('listen-stop')
				sessions.clear()
				pendingByLinkId.clear()
			}
		},
	}
}
