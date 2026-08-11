import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'

import { base64ToBytes, bytesToBase64 } from '../../core/bytes_codec.mjs'
import { normalizeHex64 } from '../../core/hexIds.mjs'
import { getDiscoveryProvider, sendNodeSignalPacket } from '../../discovery/index.mjs'
import { mergeSignalingRelayUrls } from '../../discovery/nostr.mjs'
import { getNodeTransportSettings } from '../../node/identity.mjs'
import { getSignalingRuntimeConfig } from '../../node/instance.mjs'
import { ms } from '../../utils/duration.mjs'
import { createLruMap } from '../../utils/lru.mjs'
import { asLinkHandle } from '../pipe.mjs'

import { LINK_LEVEL_NOSTR } from './levels.mjs'
import { createLinkIdBoundPipe } from './link_id_pipe.mjs'

/** 单包 payload（UTF-8 / base64）上限，避免撞 relay content 限制。 */
const MAX_LINK_PAYLOAD_CHARS = 12 * 1024
/** open 到达前为同一 linkId 暂存的 c/b 包上限。 */
const PENDING_PACKETS_MAX = 32
/** Nostr 链握手超时（relay RTT 更慢）。 */
const NOSTR_HANDSHAKE_TIMEOUT_MS = ms('30s')
/** Nostr 链心跳间隔。 */
const NOSTR_HEARTBEAT_MS = ms('60s')
/** Nostr 链空闲超时。 */
const NOSTR_IDLE_TIMEOUT_MS = ms('3m')

/**
 * @returns {string[]} 当前可用中继 URL
 */
function resolveDefaultRelayUrls() {
	return getSignalingRuntimeConfig().relayOverride
		?? mergeSignalingRelayUrls(getNodeTransportSettings().relayUrls)
}

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
 * @returns {import('./index.mjs').LinkProvider & { deliverPacket: (packet: object) => void }} provider
 */
export function createNostrLinkProvider(options = {}) {
	const resolveRelayUrls = options.getRelayUrls || resolveDefaultRelayUrls

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
	 * @returns {Promise<void>}
	 */
	async function sendOp(remoteNodeHash, linkId, op, payload) {
		if (payload != null && payload.length > MAX_LINK_PAYLOAD_CHARS)
			throw new Error('p2p: nostr link payload too large')
		const packet = {
			type: 'link',
			op,
			from: localIdentity?.nodeHash || '',
			linkId,
		}
		if (payload != null) packet.payload = payload
		await publishLinkPacket(remoteNodeHash, packet)
	}

	/**
	 * @param {object} opts 会话选项
	 * @returns {ReturnType<typeof createLinkIdBoundPipe>} pipe
	 */
	function openPipe(opts) {
		const { linkId, remoteNodeHash, initiator } = opts
		const pipe = createLinkIdBoundPipe({
			providerId: 'nostr',
			level: LINK_LEVEL_NOSTR,
			initiator: !!initiator,
			linkId,
			nodeHash: remoteNodeHash,
			localIdentity: opts.localIdentity || localIdentity,
			handshakeTimeoutMs: NOSTR_HANDSHAKE_TIMEOUT_MS,
			heartbeatMs: NOSTR_HEARTBEAT_MS,
			idleTimeoutMs: NOSTR_IDLE_TIMEOUT_MS,
			/**
			 * @param {string} text control JSON
			 * @returns {Promise<void>}
			 */
			async sendControlText(text) {
				await sendOp(remoteNodeHash, linkId, 'c', text)
			},
			/**
			 * @param {string} _action action
			 * @param {Uint8Array} frame 帧
			 * @returns {Promise<void>}
			 */
			async sendFrame(_action, frame) {
				await sendOp(remoteNodeHash, linkId, 'b', bytesToBase64(frame))
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
	 * @returns {void}
	 */
	function deliverPacket(packet) {
		if (packet?.type !== 'link') return
		const linkId = normalizeHex64(packet.linkId)
		const from = normalizeHex64(packet.from)
		if (!linkId || !from) return
		if (localIdentity?.nodeHash && from === localIdentity.nodeHash) return

		const op = String(packet.op || '')
		if (op === 'open') {
			if (sessions.has(linkId)) return
			if (!onInbound || !localIdentity) return
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
			const remoteNodeHash = normalizeHex64(dialOptions.nodeHash)
			if (!remoteNodeHash) return null
			localIdentity = dialOptions.localIdentity || localIdentity
			if (!localIdentity?.nodeHash) throw new Error('p2p: nostr dial requires localIdentity')
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
			return () => {
				onInbound = null
				for (const session of sessions.values())
					void session.pipe.close('listen-stop')
				sessions.clear()
				pendingByLinkId.clear()
			}
		},
	}
}
