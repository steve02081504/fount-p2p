import { randomBytes } from 'node:crypto'

import { schnorr } from '@noble/curves/secp256k1.js'
import WebSocket from 'ws'

import { base64ToBytes, hexToBytes, bytesToBase64, bytesToHex } from '../core/bytes_codec.mjs'
import { isHex64, normalizeHex64 } from '../core/hexIds.mjs'
import { sha256Hex } from '../crypto/crypto.mjs'
import { getNodeTransportSettings } from '../node/identity.mjs'
import { getSignalingRuntimeConfig } from '../node/instance.mjs'
import { nodeDebug, shortHash } from '../node/log.mjs'

import { noteAdvertPeerHints } from './advert_peer_hints.mjs'
import { ingestEncryptedAdvert } from './adverts.mjs'
import {
	encryptSignalPacket,
	groupRendezvousKey,
	networkRendezvousKey,
	nodeRendezvousKey,
} from './internal/signal_crypto.mjs'
import { noteDiscoveryPeerClue } from './peer_clue.mjs'

/** 默认 Nostr 中继 URL 列表。 */
export const DEFAULT_RELAY_URLS = [
	'wss://relay.damus.io',
	'wss://nos.lol',
	'wss://relay.nostr.band',
]

/** 单中继 WebSocket 首连超时（短超时 + 并行，避免串行 10s×N）。 */
export const NOSTR_CONNECT_TIMEOUT_MS = 2_000
/** 先 close，超时未 CLOSED 再 terminate（给对端优雅关闭的窗口）。 */
export const NOSTR_CLOSE_GRACE_MS = 1_000

/** 单 relay 等待 EVENT OK 回执超时。 */
export const NOSTR_PUBLISH_OK_TIMEOUT_MS = 3_000
/** 共享 relay 会话断线后重连间隔。 */
export const NOSTR_RECONNECT_DELAY_MS = 500
/** 无 sub/publish 工作时共享 relay 空闲回收延迟（给连续 send 复用窗口）。 */
export const NOSTR_IDLE_DROP_MS = 2_000

/** Nostr network advert 事件 kind（addressable，可存储）。 */
export const NOSTR_ADVERT_KIND = 30787
/** Nostr signal 事件 kind（ephemeral，实时转发）。 */
export const NOSTR_SIGNAL_KIND = 20787

/** 打广告用的话题 tag（hashtag，NIP-01），公开可被搜索聚合。 */
const NOSTR_TOPIC_TAG = ['t', 'fount']

const ADVERT_TTL_MS = 10 * 60_000

/** @type {Map<string, number>} 网络域 nodeHash → lastSeenAt */
const visibleByHash = new Map()
/** @type {Map<string, Map<string, number>>} roomSecret → (nodeHash → lastSeenAt) */
const visibleByGroup = new Map()

/**
 * @param {Map<string, number>} pool 可见池
 * @param {number} now 当前时间
 * @param {number} ttlMs TTL
 * @returns {string[]} 未过期 nodeHash
 */
function listPoolHashes(pool, now, ttlMs) {
	/** @type {string[]} */
	const out = []
	for (const [hash, seenAt] of pool)
		if (now - seenAt <= ttlMs) out.push(hash)
		else pool.delete(hash)
	return out
}

/**
 * 写入网络域可见池（非群）。
 * @param {string} nodeHash 节点 hash
 * @param {number} [now=Date.now()] 当前时间
 * @returns {void}
 */
export function noteNostrVisibleNode(nodeHash, now = Date.now()) {
	const hash = normalizeHex64(nodeHash)
	if (!isHex64(hash)) return
	visibleByHash.set(hash, now)
}

/**
 * 写入群域可见池（与网络域隔离）。
 * @param {string} roomSecret 房间密钥
 * @param {string} nodeHash 节点 hash
 * @param {number} [now=Date.now()] 当前时间
 * @returns {void}
 */
export function noteNostrGroupVisibleNode(roomSecret, nodeHash, now = Date.now()) {
	const hash = normalizeHex64(nodeHash)
	if (!roomSecret || !isHex64(hash)) return
	let pool = visibleByGroup.get(roomSecret)
	if (!pool) {
		pool = new Map()
		visibleByGroup.set(roomSecret, pool)
	}
	pool.set(hash, now)
}

/**
 * @param {number} [now=Date.now()] 当前时间
 * @param {number} [ttlMs=ADVERT_TTL_MS] TTL
 * @returns {string[]} 网络域可见 nodeHash
 */
export function listNostrVisibleNodeHashes(now = Date.now(), ttlMs = ADVERT_TTL_MS) {
	return listPoolHashes(visibleByHash, now, ttlMs)
}

/**
 * @param {string} roomSecret 房间密钥
 * @param {number} [now=Date.now()] 当前时间
 * @param {number} [ttlMs=ADVERT_TTL_MS] TTL
 * @returns {string[]} 该群可见 nodeHash
 */
export function listNostrGroupVisibleNodeHashes(roomSecret, now = Date.now(), ttlMs = ADVERT_TTL_MS) {
	const pool = visibleByGroup.get(roomSecret)
	if (!pool) return []
	const out = listPoolHashes(pool, now, ttlMs)
	if (!pool.size) visibleByGroup.delete(roomSecret)
	return out
}

/**
 * 解密并验签后写入 Nostr 可见池；伪造 body.nodeHash 无效。
 * @param {string} rendezvousKey rendezvous 键
 * @param {Uint8Array} bytes 加密 advert
 * @param {{ roomSecret?: string, skipNodeHash?: string, meta?: object }} [options] 群池 / 本机回环过滤 / meta
 * @returns {Promise<string | null>} 验签通过的 nodeHash
 */
export async function acceptNostrAdvert(rendezvousKey, bytes, options = {}) {
	const ingested = await ingestEncryptedAdvert(rendezvousKey, bytes)
	if (!ingested) return null
	const hash = ingested.verifiedNodeHash
	const skipHash = options.skipNodeHash ? normalizeHex64(options.skipNodeHash) : null
	if (skipHash && hash === skipHash) return hash
	const { roomSecret } = options
	let firstSeen = true
	if (roomSecret) {
		firstSeen = !visibleByGroup.get(roomSecret)?.has(hash)
		noteNostrGroupVisibleNode(roomSecret, hash)
	}
	else {
		firstSeen = !visibleByHash.has(hash)
		noteNostrVisibleNode(hash)
	}
	if (firstSeen) {
		noteDiscoveryPeerClue(hash)
		nodeDebug('p2p:nostr peer visible', { peer: shortHash(hash), group: !!roomSecret })
	}
	noteAdvertPeerHints(hash, ingested.body, options.meta || {})
	return hash
}

/** @returns {void} 测试用 */
export function clearNostrVisibleNodes() {
	visibleByHash.clear()
	visibleByGroup.clear()
}

/**
 * 关掉 WebSocket：已连上则先 close，grace 内未 CLOSED 再 terminate。
 * @param {import('ws').WebSocket} ws 连接
 * @returns {void}
 */
function dropWebSocket(ws) {
	if (ws.readyState === WebSocket.CLOSED) return
	if (ws.readyState === WebSocket.CONNECTING) {
		try { ws.terminate() } catch { /* ignore */ }
		return
	}
	const timer = setTimeout(() => {
		if (ws.readyState !== WebSocket.CLOSED)
			try { ws.terminate() } catch { /* ignore */ }
	}, NOSTR_CLOSE_GRACE_MS)
	timer.unref()
	ws.once('close', () => clearTimeout(timer))
	try {
		ws.close()
	}
	catch {
		clearTimeout(timer)
		try { ws.terminate() } catch { /* ignore */ }
	}
}

/**
 * @param {string[] | undefined | null} urls 原始列表
 * @returns {string[]} 清洗后的列表
 */
function dedupeRelayUrls(urls) {
	const seen = new Set()
	return (urls || [])
		.map(url => String(url || ''))
		.filter(url => url && !seen.has(url) && (seen.add(url), true))
}

/**
 * @param {string[] | undefined | null} userRelayUrls 用户自定义中继列表
 * @returns {string[]} 合并后的中继 URL 列表
 */
export function mergeSignalingRelayUrls(userRelayUrls) {
	const merged = dedupeRelayUrls([...DEFAULT_RELAY_URLS, ...userRelayUrls || []])
	return merged.length ? merged : [...DEFAULT_RELAY_URLS]
}

/**
 * 当前可用 nostr 中继：nostr 通道配置 relay（替换默认），否则节点默认 + 公共中继。
 * @returns {string[]} relay URL 列表
 */
export function resolveNostrRelayUrls() {
	const relay = getSignalingRuntimeConfig().channels?.nostr?.relay
	return relay?.length ? relay : mergeSignalingRelayUrls(getNodeTransportSettings().relayUrls)
}

/**
 * @param {number} kind 事件 kind
 * @param {string[][]} tags 事件标签
 * @param {string} content 事件内容
 * @param {Uint8Array} secretKey Schnorr 私钥
 * @returns {Promise<object>} 已签名的 Nostr 事件对象
 */
async function signNostrEvent(kind, tags, content, secretKey) {
	const pubkey = bytesToHex(schnorr.getPublicKey(secretKey))
	const created_at = Math.floor(Date.now() / 1000)
	const serialized = JSON.stringify([0, pubkey, created_at, kind, tags, content])
	const id = sha256Hex(serialized)
	const sig = bytesToHex(await schnorr.sign(hexToBytes(id), secretKey))
	return { id, pubkey, created_at, kind, tags, content, sig }
}

/**
 * @param {string} relayUrl 中继 URL
 * @param {number} [timeoutMs] 超时毫秒
 * @param {AbortSignal} [signal] 取消信号
 * @returns {Promise<import('ws').WebSocket>} 已打开的 WebSocket
 */
function connectRelay(relayUrl, timeoutMs = NOSTR_CONNECT_TIMEOUT_MS, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error('nostr: aborted'))
			return
		}
		const ws = new WebSocket(relayUrl)
		let settled = false
		/**
		 * @param {Error} error 失败原因
		 * @returns {void}
		 */
		const fail = error => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			signal?.removeEventListener('abort', onAbort)
			dropWebSocket(ws)
			reject(error)
		}
		/**
		 * 收到 abort 信号时失败
		 * @returns {void}
		 */
		const onAbort = () => fail(new Error('nostr: aborted'))
		const timer = setTimeout(() => fail(new Error(`nostr: connect timeout for ${relayUrl}`)), timeoutMs)
		timer.unref()
		signal?.addEventListener('abort', onAbort, { once: true })
		ws.once('open', () => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			signal?.removeEventListener('abort', onAbort)
			resolve(ws)
		})
		ws.once('error', () => {
			fail(new Error(`nostr: websocket error for ${relayUrl}`))
		})
	})
}

/**
 * @param {import('ws').WebSocket} ws 已连接 relay
 * @param {string} relayUrl 中继 URL
 * @param {object} event 待发布事件
 * @param {AbortSignal} [signal] 取消信号
 * @param {() => boolean} [isCurrent] 该尝试是否仍是 publishRequest 的当前尝试（断线重发后过期）
 * @returns {Promise<boolean>} relay 是否接受 EVENT
 */
function publishEventOnRelay(ws, relayUrl, event, signal, isCurrent) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error('nostr: aborted'))
			return
		}
		let settled = false
		/**
		 * @param {boolean} ok relay 是否接受
		 * @param {Error | null} [error] 失败原因
		 * @returns {void}
		 */
		const finish = (ok, error = null) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			signal?.removeEventListener('abort', onAbort)
			ws.off('message', onMessage)
			// 过期的 in-flight 尝试：只清理自身监听器/定时器，不结算，避免影响重发后的当前尝试。
			if (!isCurrent()) return
			if (error) reject(error)
			else resolve(ok)
		}
		/**
		 * 收到 abort 信号时以失败结束
		 * @returns {void}
		 */
		const onAbort = () => finish(false, new Error('nostr: aborted'))
		/**
		 * @param {import('ws').RawData} data relay 消息
		 * @returns {void}
		 */
		const onMessage = data => {
			let parsed
			try { parsed = JSON.parse(String(data)) } catch { return }
			if (parsed?.[0] !== 'OK' || parsed[1] !== event.id) return
			const accepted = parsed[2] === true
			if (!accepted)
				nodeDebug('p2p:nostr publish rejected', {
					url: relayUrl,
					reason: String(parsed[3] || 'rejected'),
				})
			finish(accepted)
		}
		const timer = setTimeout(
			() => finish(false, new Error(`nostr: publish ok timeout for ${relayUrl}`)),
			NOSTR_PUBLISH_OK_TIMEOUT_MS,
		)
		timer.unref()
		signal?.addEventListener('abort', onAbort, { once: true })
		ws.on('message', onMessage)
		try {
			ws.send(JSON.stringify(['EVENT', event]))
		}
		catch (error) {
			finish(false, error instanceof Error ? error : new Error(String(error)))
		}
	})
}

/**
 * @param {string[]} relayUrls 中继 URL 列表
 * @param {object} event 待发布事件
 * @param {AbortSignal} [signal] 取消信号
 * @returns {Promise<void>}
 */
async function publishEvent(relayUrls, event, signal) {
	const urls = dedupeRelayUrls(relayUrls)
	if (!urls.length) throw new Error('nostr: no relay')
	let published = false
	let lastError = null
	await Promise.allSettled(urls.map(async relayUrl => {
		try {
			if (await publishViaSharedRelay(relayUrl, event, signal)) published = true
		}
		catch (error) {
			lastError = error
		}
	}))
	if (!published) throw lastError || new Error('nostr: no relay accepted publish')
}

/**
 * 一次共享 relay publish 请求：入队（pending）与已派发（inflight）时共用同一结构。
 * attempt 标识每次实际发送尝试，断线重发会递增；旧的 in-flight 尝试据此自检为过期后自我清理，
 * 不再结算当前尝试。
 * @typedef {{
 *   event: object,
 *   signal: AbortSignal | undefined,
 *   attempt: number,
 *   onAbort: (() => void) | null,
 *   removeAbort: (() => void) | null,
 *   resolve: (ok: boolean) => void,
 *   reject: (err: Error) => void,
 * }} NostrPublishRequest
 */

/**
 * 共享 relay 会话：多 SUB / publish 复用同一 URL 的 WebSocket，避免 signal/presence/advert 各建一池、
 * 以及每次 send 重开一条连接（内存泄漏）。
 * 仍有活跃 sub 或待发 publish 时断线会自动重连并重发 REQ / 重发 EVENT。
 * @typedef {{
 *   ws: import('ws').WebSocket | null,
 *   connecting: boolean,
 *   reconnectTimer: ReturnType<typeof setTimeout> | null,
 *   idleTimer: ReturnType<typeof setTimeout> | null,
 *   subs: Map<string, { filter: object, onEvent: (event: object, relayUrl: string) => void }>,
 *   pendingPublishes: Array<NostrPublishRequest>,
 *   inflightPublishes: Array<NostrPublishRequest>,
 * }} SharedRelaySession
 */

/** @type {Map<string, SharedRelaySession>} */
const sharedRelaySessions = new Map()

/**
 * 会话是否仍有需要连接的工作（sub 或待发 publish）。
 * @param {SharedRelaySession} session 会话
 * @returns {boolean} 是否有活跃工作
 */
function hasPendingWork(session) {
	return session.subs.size  || session.pendingPublishes.length  || session.inflightPublishes.length
}

/**
 * 取消会话的空闲回收定时器。
 * @param {SharedRelaySession} session 会话
 * @returns {void}
 */
function clearIdleDrop(session) {
	if (!session.idleTimer) return
	clearTimeout(session.idleTimer)
	session.idleTimer = null
}

/**
 * 会话无 sub 时，待 publish 清空后延迟回收空闲 socket（给连续 send 复用窗口）。
 * @param {string} relayUrl 中继 URL
 * @param {SharedRelaySession} session 会话
 * @returns {void}
 */
function scheduleIdleDrop(relayUrl, session) {
	if (session.subs.size || session.idleTimer) return
	session.idleTimer = setTimeout(() => {
		session.idleTimer = null
		if (!isLiveSharedSession(relayUrl, session) || hasPendingWork(session)) return
		sharedRelaySessions.delete(relayUrl)
		clearSharedRelayReconnect(session)
		if (session.ws) dropWebSocket(session.ws)
		session.ws = null
	}, NOSTR_IDLE_DROP_MS)
	session.idleTimer.unref?.()
}

/**
 * @param {string} relayUrl 中继 URL
 * @param {SharedRelaySession} session 会话
 * @returns {boolean} session 是否仍是该 URL 的活动会话
 */
function isLiveSharedSession(relayUrl, session) {
	return sharedRelaySessions.get(relayUrl) === session
}

/**
 * @param {SharedRelaySession} session 会话
 * @returns {void}
 */
function clearSharedRelayReconnect(session) {
	if (!session.reconnectTimer) return
	clearTimeout(session.reconnectTimer)
	session.reconnectTimer = null
}

/**
 * @param {string} relayUrl 中继 URL
 * @param {SharedRelaySession} session 会话
 * @param {import('ws').WebSocket} ws 已打开连接
 * @returns {void}
 */
function attachSharedRelaySocket(relayUrl, session, ws) {
	session.ws = ws
	nodeDebug('p2p:nostr relay up', { url: relayUrl })
	ws.on('message', data => {
		let parsed
		try { parsed = JSON.parse(String(data)) } catch { return }
		if (parsed?.[0] !== 'EVENT') return
		const subId = String(parsed[1] || '')
		const nostrEvent = parsed[2]
		const sub = session.subs.get(subId)
		if (!sub || !nostrEvent) return
		try { sub.onEvent(nostrEvent, relayUrl) } catch { /* ignore */ }
	})
	ws.once('close', () => {
		if (!isLiveSharedSession(relayUrl, session)) return
		session.ws = null
		// 尚未确认的 inflight publish 重新入队，重连后由 flushPendingPublishes 重发。
		if (session.inflightPublishes.length) {
			session.pendingPublishes.push(...session.inflightPublishes)
			for (const publishRequest of session.inflightPublishes)
				attachQueuedAbort(session, publishRequest)
			session.inflightPublishes = []
		}
		if (!hasPendingWork(session)) {
			sharedRelaySessions.delete(relayUrl)
			return
		}
		scheduleSharedRelayConnect(relayUrl, session, NOSTR_RECONNECT_DELAY_MS)
	})
	for (const [subId, sub] of session.subs)
		try { ws.send(JSON.stringify(['REQ', subId, sub.filter])) } catch { /* ignore */ }
	flushPendingPublishes(relayUrl, session, ws)
	if (!hasPendingWork(session)) scheduleIdleDrop(relayUrl, session)
}

/**
 * @param {string} relayUrl 中继 URL
 * @param {SharedRelaySession} session 会话
 * @param {number} [delayMs=0] 延迟毫秒（断线重连用）
 * @returns {void}
 */
function scheduleSharedRelayConnect(relayUrl, session, delayMs = 0) {
	if (!isLiveSharedSession(relayUrl, session) || session.connecting || session.ws) return
	clearSharedRelayReconnect(session)
	/** 启动/恢复共享会话连接 */
	const start = () => {
		session.reconnectTimer = null
		if (!isLiveSharedSession(relayUrl, session) || session.connecting || session.ws) return
		if (!hasPendingWork(session)) {
			sharedRelaySessions.delete(relayUrl)
			return
		}
		session.connecting = true
		void connectRelay(relayUrl, NOSTR_CONNECT_TIMEOUT_MS).then(ws => {
			session.connecting = false
			if (!isLiveSharedSession(relayUrl, session) || !hasPendingWork(session)) {
				sharedRelaySessions.delete(relayUrl)
				dropWebSocket(ws)
				return
			}
			attachSharedRelaySocket(relayUrl, session, ws)
		}).catch(error => {
			session.connecting = false
			if (!isLiveSharedSession(relayUrl, session)) return
			nodeDebug('p2p:nostr relay fail', {
				url: relayUrl,
				err: String(error?.message || error),
			})
			if (!hasPendingWork(session)) {
				sharedRelaySessions.delete(relayUrl)
				return
			}
			scheduleSharedRelayConnect(relayUrl, session, NOSTR_RECONNECT_DELAY_MS)
		})
	}
	if (delayMs <= 0) {
		// 让同一 tick 内的 registerSharedRelaySub 先写入 subs，再决定是否连接。
		queueMicrotask(start)
		return
	}
	nodeDebug('p2p:nostr relay reconnect', { url: relayUrl, delayMs })
	session.reconnectTimer = setTimeout(start, delayMs)
	session.reconnectTimer.unref?.()
}

/**
 * @param {string} relayUrl 中继 URL
 * @returns {SharedRelaySession} 共享会话
 */
function acquireSharedRelay(relayUrl) {
	const existing = sharedRelaySessions.get(relayUrl)
	if (existing) return existing
	/** @type {SharedRelaySession} */
	const session = {
		ws: null,
		connecting: false,
		reconnectTimer: null,
		idleTimer: null,
		subs: new Map(),
		pendingPublishes: [],
		inflightPublishes: [],
	}
	sharedRelaySessions.set(relayUrl, session)
	scheduleSharedRelayConnect(relayUrl, session)
	return session
}

/**
 * @param {string} relayUrl 中继 URL
 * @param {string} subscriptionId 订阅 id
 * @returns {void}
 */
function releaseSharedRelaySub(relayUrl, subscriptionId) {
	const session = sharedRelaySessions.get(relayUrl)
	if (!session) return
	session.subs.delete(subscriptionId)
	const { ws } = session
	if (ws?.readyState === WebSocket.OPEN)
		try { ws.send(JSON.stringify(['CLOSE', subscriptionId])) } catch { /* ignore */ }
	if (hasPendingWork(session)) return
	sharedRelaySessions.delete(relayUrl)
	clearSharedRelayReconnect(session)
	clearIdleDrop(session)
	if (ws) dropWebSocket(ws)
}

/**
 * 在已打开的共享连接上登记 REQ；连接中则等 attach 时统一重放。
 * @param {SharedRelaySession} session 会话
 * @param {string} subscriptionId 订阅 id
 * @param {object} filter Nostr filter
 * @param {(event: object, relayUrl: string) => void} onEvent 事件回调
 * @returns {void}
 */
function registerSharedRelaySub(session, subscriptionId, filter, onEvent) {
	session.subs.set(subscriptionId, { filter, onEvent })
	clearIdleDrop(session)
	const { ws } = session
	if (ws?.readyState !== WebSocket.OPEN) return
	try { ws.send(JSON.stringify(['REQ', subscriptionId, filter])) } catch { /* ignore */ }
}

/**
 * 将已入队的 publish 逐个派发到已打开 socket 上；复用 publishEventOnRelay 等 OK 回执。
 * 每个 publish 独立携带自己的 message/abort 监听，socket 共享安全。
 * @param {string} relayUrl 中继 URL
 * @param {SharedRelaySession} session 会话
 * @param {import('ws').WebSocket} socket 已打开连接
 * @returns {void}
 */
function flushPendingPublishes(relayUrl, session, socket) {
	const pending = session.pendingPublishes
	session.pendingPublishes = []
	for (const publishRequest of pending) {
		publishRequest.removeAbort?.()
		publishRequest.onAbort = null
		publishRequest.removeAbort = null
		const attempt = ++publishRequest.attempt
		session.inflightPublishes.push(publishRequest)
		void publishEventOnRelay(socket, relayUrl, publishRequest.event, publishRequest.signal, () => publishRequest.attempt === attempt)
			.then(
				ok => settleInflightPublish(relayUrl, session, publishRequest, attempt, () => publishRequest.resolve(ok)),
				error => settleInflightPublish(relayUrl, session, publishRequest, attempt, () => publishRequest.reject(error)),
			)
	}
}

/**
 * 为队列中的 publish 挂上 abort 处理：先移除监听器（释放 signal 对回调/event/session 的引用），
 * 再从队列删除并 reject。
 * @param {SharedRelaySession} session 会话
 * @param {SharedRelaySession['pendingPublishes'][number]} publishRequest 待发请求
 * @returns {void}
 */
function attachQueuedAbort(session, publishRequest) {
	const { signal, reject } = publishRequest
	/**
	 * 处理 abort 事件
	 */
	publishRequest.onAbort = () => {
		publishRequest.removeAbort?.()
		const pendingIndex = session.pendingPublishes.indexOf(publishRequest)
		if (pendingIndex < 0) return
		session.pendingPublishes.splice(pendingIndex, 1)
		reject(new Error('nostr: aborted'))
	}
	/**
	 * 移除 abort 监听器
	 */
	publishRequest.removeAbort = () => {
		if (signal) signal.removeEventListener('abort', publishRequest.onAbort)
	}
	if (signal) signal.addEventListener('abort', publishRequest.onAbort, { once: true })
}

/**
 * publish 在 socket 上得到 OK / 失败 / abort 后结算：从 inflight 移除并 settle。
 * 仅结算仍与当前 attempt 匹配的请求：断线重发后 attempt 已递增，旧尝试的结算在此短路，
 * 避免提前结算重发后的当前尝试。已被 requeue（断线重发）的请求不在 inflight，跳过结算。
 * @param {string} relayUrl 中继 URL
 * @param {SharedRelaySession} session 会话
 * @param {SharedRelaySession['inflightPublishes'][number]} publishRequest 已发送请求
 * @param {number} attempt 本次发送的 attempt 标识
 * @param {() => void} settle 结算回调（resolve/reject）
 * @returns {void}
 */
function settleInflightPublish(relayUrl, session, publishRequest, attempt, settle) {
	if (publishRequest.attempt !== attempt) return
	const inflightIndex = session.inflightPublishes.indexOf(publishRequest)
	if (inflightIndex < 0) return
	session.inflightPublishes.splice(inflightIndex, 1)
	settle()
	if (!hasPendingWork(session)) scheduleIdleDrop(relayUrl, session)
}

/**
 * 通过共享 relay 会话发布 EVENT：复用已打开 socket，避免每次 send 重开一条连接（内存泄漏）。
 * 无现成连接时入队并触发连接，连上后由 flushPendingPublishes 统一派发。
 * @param {string} relayUrl 中继 URL
 * @param {object} event 待发布事件
 * @param {AbortSignal} [signal] 取消信号
 * @returns {Promise<boolean>} relay 是否接受 EVENT
 */
function publishViaSharedRelay(relayUrl, event, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error('nostr: aborted'))
			return
		}
		const session = acquireSharedRelay(relayUrl)
		clearIdleDrop(session)
		/** @type {SharedRelaySession['pendingPublishes'][number]} */
		const publishRequest = { event, signal, attempt: 0, resolve, reject, onAbort: null, removeAbort: null }
		attachQueuedAbort(session, publishRequest)
		session.pendingPublishes.push(publishRequest)
		if (session.ws?.readyState === WebSocket.OPEN)
			flushPendingPublishes(relayUrl, session, session.ws)
		else
			scheduleSharedRelayConnect(relayUrl, session)
	})
}

/**
 * 内部：按 rendezvous 键订阅 Nostr kind（topic 不导出）。多订阅共享每 URL 一条连接。
 * @param {string[]} relayUrls 中继 URL 列表
 * @param {{ kind: number, rendezvousKey: string, tagX: string, onPayload: (bytes: Uint8Array, meta: { relayUrl: string, event: object }) => void | Promise<void>, addressable?: boolean }} options 订阅选项
 * @returns {() => void} 取消订阅
 */
function subscribeNostrKind(relayUrls, options) {
	const { kind, rendezvousKey, tagX, onPayload, addressable = false } = options
	const subscriptionId = randomBytes(8).toString('hex')
	const filter = { kinds: [kind], '#t': [rendezvousKey], '#x': [tagX] }
	if (addressable) filter['#d'] = [rendezvousKey]
	/**
	 * @param {object} nostrEvent Nostr EVENT
	 * @param {string} relayUrl 来源中继
	 * @returns {void}
	 */
	const onEvent = (nostrEvent, relayUrl) => {
		if (nostrEvent?.kind !== kind) return
		try {
			const result = onPayload(base64ToBytes(nostrEvent.content), { relayUrl, event: nostrEvent })
			if (result?.then) void result.catch(() => { })
		}
		catch { /* ignore */ }
	}
	const urls = dedupeRelayUrls(relayUrls)
	for (const relayUrl of urls)
		registerSharedRelaySub(acquireSharedRelay(relayUrl), subscriptionId, filter, onEvent)
	return () => {
		for (const relayUrl of urls) releaseSharedRelaySub(relayUrl, subscriptionId)
	}
}

/**
 * 创建 Nostr discovery provider（list+connect；topic 仅内部）。
 * @param {{ relayUrls?: string[] | null, getRelayUrls?: () => string[] | null | undefined, localNodeHash?: string }} [options] 中继配置与本机 hash
 * @returns {import('./index.mjs').DiscoveryProvider} Nostr discovery provider
 */
export function createNostrDiscoveryProvider(options = {}) {
	/**
	 * @returns {string[]} 去重后的中继 URL 列表
	 */
	const resolveRelayUrls = () => {
		if (options.getRelayUrls) {
			const urls = options.getRelayUrls()
			return dedupeRelayUrls(urls == null ? DEFAULT_RELAY_URLS : urls)
		}
		if (options.relayUrls === undefined || options.relayUrls === null)
			return dedupeRelayUrls(DEFAULT_RELAY_URLS)
		return dedupeRelayUrls(options.relayUrls)
	}
	const secretKey = randomBytes(32)
	const seededSelf = normalizeHex64(options.localNodeHash)
	/** @type {string | null} */
	let selfNodeHash = isHex64(seededSelf) ? seededSelf : null
	const NETWORK_SUB_KEY = 'network'
	/**
	 * @typedef {{ stop: () => void, held: boolean, listeners: Set<(bytes: Uint8Array, meta: object) => void> }} AdvertSubEntry
	 */
	/** @type {Map<string, AdvertSubEntry>} */
	const advertSubs = new Map()
	/** @type {Map<string, () => void>} */
	const nodeSignalSubs = new Map()

	/**
	 * @param {string | undefined | null} nodeHash 本机 hash
	 * @returns {void}
	 */
	function noteSelfNodeHash(nodeHash) {
		const hash = normalizeHex64(nodeHash)
		if (isHex64(hash)) selfNodeHash = hash
	}

	/**
	 * @param {string} key 订阅键
	 * @param {AdvertSubEntry} entry 条目
	 * @returns {void}
	 */
	function releaseAdvertEntryIfIdle(key, entry) {
		if (entry.held || entry.listeners.size) return
		try { entry.stop() } catch { /* ignore */ }
		advertSubs.delete(key)
	}

	/**
	 * pool/connect 永久 hold；watch listener 归零且无 hold 时拆 REQ。
	 * @param {string} key 订阅键
	 * @param {{ rendezvousKey: string, roomSecret?: string }} bind advert 绑定
	 * @param {(bytes: Uint8Array, meta: object) => void} [listener] 额外监听
	 * @returns {() => void} 取消 listener；无 listener 时 no-op（hold 至 dispose）
	 */
	function ensureAdvertSubscription(key, bind, listener) {
		if (!key) return () => { }
		let entry = advertSubs.get(key)
		if (!entry) {
			/** @type {AdvertSubEntry} */
			const created = {
				/**
				 * @returns {void}
				 */
				stop: () => { }, held: false, listeners: new Set()
			}
			created.stop = subscribeNostrKind(resolveRelayUrls(), {
				kind: NOSTR_ADVERT_KIND,
				rendezvousKey: bind.rendezvousKey,
				tagX: 'advert',
				addressable: true,
				/**
				 * @param {Uint8Array} bytes 加密 advert 载荷
				 * @param {object} meta relay 元数据
				 * @returns {Promise<void>}
				 */
				async onPayload(bytes, meta) {
					await acceptNostrAdvert(bind.rendezvousKey, bytes, {
						roomSecret: bind.roomSecret,
						skipNodeHash: selfNodeHash || undefined,
						meta,
					})
					for (const fn of created.listeners)
						try { fn(bytes, meta) } catch { /* ignore */ }
				},
			})
			entry = created
			advertSubs.set(key, entry)
		}
		if (!listener) {
			entry.held = true
			return () => { }
		}
		entry.listeners.add(listener)
		return () => {
			entry.listeners.delete(listener)
			releaseAdvertEntryIfIdle(key, entry)
		}
	}

	/**
	 * @returns {() => void} no-op（network hold 至 dispose）
	 */
	function ensureNetworkAdvertSubscription() {
		return ensureAdvertSubscription(NETWORK_SUB_KEY, {
			rendezvousKey: networkRendezvousKey(),
		})
	}

	/**
	 * @param {string} roomSecret 房间密钥
	 * @param {(bytes: Uint8Array, meta: object) => void} [listener] 额外 advert 监听
	 * @returns {() => void} 取消 listener
	 */
	function ensureGroupSubscription(roomSecret, listener) {
		if (!roomSecret) return () => { }
		return ensureAdvertSubscription('group:' + roomSecret, {
			rendezvousKey: groupRendezvousKey(roomSecret),
			roomSecret,
		}, listener)
	}

	/**
	 * @param {string} nodeHash 目标
	 * @param {(bytes: Uint8Array, meta: object) => void} [listener] 额外 advert 监听
	 * @returns {() => void} 取消 listener
	 */
	function ensureNodeAdvertSubscription(nodeHash, listener) {
		const hash = normalizeHex64(nodeHash)
		if (!isHex64(hash)) return () => { }
		return ensureAdvertSubscription('node:' + hash, {
			rendezvousKey: nodeRendezvousKey(hash),
		}, listener)
	}

	return {
		id: 'nostr',
		priority: 100,
		caps: { canDiscover: true, canSignal: true, canRelay: false },
		/**
		 * @param {{ limit?: number, roomSecret?: string }} [options] 扫描选项
		 * @returns {Promise<string[]>} 可见 nodeHash；带 roomSecret 时仅返回该群池
		 */
		async listVisibleNodeHashes(options = {}) {
			const limit = Math.max(1, Number(options.limit) || 64)
			if (options.roomSecret) {
				ensureGroupSubscription(options.roomSecret)
				return listNostrGroupVisibleNodeHashes(options.roomSecret)
					.filter(hash => hash !== selfNodeHash)
					.slice(0, limit)
			}
			ensureNetworkAdvertSubscription()
			return listNostrVisibleNodeHashes()
				.filter(hash => hash !== selfNodeHash)
				.slice(0, limit)
		},
		/**
		 * 挂上对该节点的内部 advert 订阅（建链由 registry dialer / ensureLinkToNode 完成）。
		 * @param {string} nodeHash 目标
		 * @returns {Promise<boolean>} 是否已准备
		 */
		async connectToNode(nodeHash) {
			const hash = normalizeHex64(nodeHash)
			if (!isHex64(hash)) return false
			ensureNodeAdvertSubscription(hash)
			return true
		},
		/**
		 * @param {() => Promise<object | null>} getBeacon 本机 advert body 工厂
		 * @returns {Promise<() => void>} 停止函数
		 */
		async startPresence(getBeacon) {
			const rendezvousKey = networkRendezvousKey()
			const abortController = new AbortController()
			ensureNetworkAdvertSubscription()
			/**
			 * @returns {Promise<void>}
			 */
			const publish = async () => {
				if (abortController.signal.aborted) return
				const beacon = await getBeacon?.()
				if (!beacon?.nodeHash) return
				noteSelfNodeHash(beacon.nodeHash)
				const advertBody = beacon.advertBody || beacon.body || beacon
				const bytes = encryptSignalPacket(rendezvousKey, { type: 'advert', body: advertBody })
				const event = await signNostrEvent(
					NOSTR_ADVERT_KIND,
					[NOSTR_TOPIC_TAG, ['t', rendezvousKey], ['x', 'advert'], ['d', rendezvousKey]],
					bytesToBase64(bytes),
					secretKey,
				)
				await publishEvent(resolveRelayUrls(), event, abortController.signal)
				nodeDebug('p2p:nostr presence published', { self: shortHash(beacon.nodeHash) })
			}
			void publish().catch(error => {
				nodeDebug('p2p:nostr presence publish fail', { err: String(error?.message || error) })
			})
			const timer = setInterval(() => {
				void publish().catch(error => {
					nodeDebug('p2p:nostr presence publish fail', { err: String(error?.message || error) })
				})
			}, 5 * 60_000)
			timer.unref?.()
			return () => {
				abortController.abort()
				clearInterval(timer)
			}
		},
		/**
		 * @param {string} toNodeHash 目标 nodeHash
		 * @param {Uint8Array} bytes 加密信令
		 * @returns {Promise<void>}
		 */
		async sendNodeSignal(toNodeHash, bytes) {
			const hash = normalizeHex64(toNodeHash)
			if (!isHex64(hash)) throw new Error('nostr: invalid nodeHash')
			const rendezvousKey = nodeRendezvousKey(hash)
			const event = await signNostrEvent(
				NOSTR_SIGNAL_KIND,
				[NOSTR_TOPIC_TAG, ['t', rendezvousKey], ['x', 'signal'], ['p', hash]],
				bytesToBase64(bytes),
				secretKey,
			)
			await publishEvent(resolveRelayUrls(), event)
		},
		/**
		 * @param {string} localNodeHash 本机 nodeHash
		 * @param {(bytes: Uint8Array) => void} onSignal 信令回调
		 * @returns {Promise<() => void>} 取消函数
		 */
		async listenNodeSignals(localNodeHash, onSignal) {
			const hash = normalizeHex64(localNodeHash)
			if (!isHex64(hash)) throw new Error('nostr: invalid nodeHash')
			noteSelfNodeHash(hash)
			const rendezvousKey = nodeRendezvousKey(hash)
			const existing = nodeSignalSubs.get(hash)
			if (existing) existing()
			nodeDebug('p2p:nostr signal listen', { self: shortHash(hash), relays: resolveRelayUrls().length })
			const stop = subscribeNostrKind(resolveRelayUrls(), {
				kind: NOSTR_SIGNAL_KIND,
				rendezvousKey,
				tagX: 'signal',
				onPayload: onSignal,
			})
			nodeSignalSubs.set(hash, stop)
			return () => {
				stop()
				nodeSignalSubs.delete(hash)
			}
		},
		/**
		 * @param {string} nodeHash 目标 nodeHash
		 * @param {(bytes: Uint8Array, meta: object) => void} onAdvert advert 回调
		 * @returns {Promise<() => void>} 取消函数
		 */
		async watchNodeAdvert(nodeHash, onAdvert) {
			const hash = normalizeHex64(nodeHash)
			if (!isHex64(hash)) throw new Error('nostr: invalid nodeHash')
			return ensureNodeAdvertSubscription(hash, onAdvert)
		},
		/**
		 * @param {string} roomSecret 房间密钥
		 * @param {() => Promise<object | null>} getBeacon advert 工厂
		 * @returns {Promise<() => void>} 停止群 presence 广播
		 */
		async startGroupPresence(roomSecret, getBeacon) {
			const rendezvousKey = groupRendezvousKey(roomSecret)
			const abortController = new AbortController()
			ensureGroupSubscription(roomSecret)
			/**
			 * @returns {Promise<void>}
			 */
			const publish = async () => {
				if (abortController.signal.aborted) return
				const beacon = await getBeacon?.()
				if (!beacon?.nodeHash) return
				noteSelfNodeHash(beacon.nodeHash)
				const advertBody = beacon.advertBody || beacon.body || beacon
				const bytes = encryptSignalPacket(rendezvousKey, { type: 'advert', body: advertBody })
				const event = await signNostrEvent(
					NOSTR_ADVERT_KIND,
					[NOSTR_TOPIC_TAG, ['t', rendezvousKey], ['x', 'advert'], ['d', rendezvousKey]],
					bytesToBase64(bytes),
					secretKey,
				)
				await publishEvent(resolveRelayUrls(), event, abortController.signal)
			}
			void publish().catch(() => { })
			const timer = setInterval(() => { void publish().catch(() => { }) }, 5 * 60_000)
			timer.unref?.()
			return () => {
				abortController.abort()
				clearInterval(timer)
			}
		},
		/**
		 * @param {string} roomSecret 房间密钥
		 * @param {(bytes: Uint8Array, meta: object) => void} onAdvert 回调
		 * @returns {Promise<() => void>} 取消群 advert 监听
		 */
		async watchGroupAdverts(roomSecret, onAdvert) {
			return ensureGroupSubscription(roomSecret, onAdvert)
		},
		/**
		 * 供 advert 解析路径写入可见 hash。
		 * @param {string} nodeHash 节点 hash
		 * @param {{ roomSecret?: string }} [options] 带 roomSecret 时写入群池
		 * @returns {void}
		 */
		noteVisibleNode(nodeHash, options = {}) {
			if (options.roomSecret) noteNostrGroupVisibleNode(options.roomSecret, nodeHash)
			else noteNostrVisibleNode(nodeHash)
		},
		/**
		 * 停止全部内部订阅（reload / unregister 时调用）。
		 * @returns {void}
		 */
		dispose() {
			for (const entry of advertSubs.values())
				try { entry.stop() } catch { /* ignore */ }
			advertSubs.clear()
			for (const stop of nodeSignalSubs.values())
				try { stop() } catch { /* ignore */ }
			nodeSignalSubs.clear()
		},
	}
}
