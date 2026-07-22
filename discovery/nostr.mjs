import { randomBytes } from 'node:crypto'

import { schnorr } from '@noble/curves/secp256k1.js'
import WebSocket from 'ws'

import { base64ToBytes, hexToBytes, bytesToBase64, bytesToHex } from '../core/bytes_codec.mjs'
import { isHex64, normalizeHex64 } from '../core/hexIds.mjs'
import { sha256Hex } from '../crypto/crypto.mjs'
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

/** Nostr network advert 事件 kind（addressable，可存储）。 */
export const NOSTR_ADVERT_KIND = 30787
/** Nostr signal 事件 kind（ephemeral，实时转发）。 */
export const NOSTR_SIGNAL_KIND = 20787

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
	const key = String(roomSecret || '')
	const hash = normalizeHex64(nodeHash)
	if (!key || !isHex64(hash)) return
	let pool = visibleByGroup.get(key)
	if (!pool) {
		pool = new Map()
		visibleByGroup.set(key, pool)
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
	const key = String(roomSecret || '')
	const pool = visibleByGroup.get(key)
	if (!pool) return []
	const out = listPoolHashes(pool, now, ttlMs)
	if (!pool.size) visibleByGroup.delete(key)
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
	const roomSecret = options.roomSecret
	let firstSeen = true
	if (roomSecret) {
		const key = String(roomSecret || '')
		firstSeen = !visibleByGroup.get(key)?.has(hash)
		noteNostrGroupVisibleNode(key, hash)
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
		.map(url => url.trim())
		.filter(trimmed => trimmed && !seen.has(trimmed) && (seen.add(trimmed), true))
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
 * @returns {Promise<boolean>} relay 是否接受 EVENT
 */
function publishEventOnRelay(ws, relayUrl, event, signal) {
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
			if (error) reject(error)
			else resolve(ok)
		}
		/**
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
	if (!relayUrls.length) throw new Error('nostr: no relay')
	let published = false
	let lastError = null
	await Promise.allSettled(relayUrls.map(async relayUrl => {
		if (signal?.aborted) throw new Error('nostr: aborted')
		const ws = await connectRelay(relayUrl, NOSTR_CONNECT_TIMEOUT_MS, signal)
		try {
			if (signal?.aborted) throw new Error('nostr: aborted')
			const ok = await publishEventOnRelay(ws, relayUrl, event, signal)
			if (ok) published = true
		}
		catch (error) {
			lastError = error
			throw error
		}
		finally {
			dropWebSocket(ws)
		}
	}))
	if (!published) throw lastError || new Error('nostr: no relay accepted publish')
}

/**
 * 共享 relay 会话：多 SUB 复用同一 URL 的 WebSocket，避免 signal/presence/advert 各建一池。
 * 仍有活跃 sub 时断线会自动重连并重发 REQ。
 * @typedef {{
 *   ws: import('ws').WebSocket | null,
 *   connecting: boolean,
 *   reconnectTimer: ReturnType<typeof setTimeout> | null,
 *   subs: Map<string, { filter: object, onEvent: (event: object, relayUrl: string) => void }>,
 * }} SharedRelaySession
 */

/** @type {Map<string, SharedRelaySession>} */
const sharedRelaySessions = new Map()

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
		if (!session.subs.size) {
			sharedRelaySessions.delete(relayUrl)
			return
		}
		scheduleSharedRelayConnect(relayUrl, session, NOSTR_RECONNECT_DELAY_MS)
	})
	for (const [subId, sub] of session.subs)
		try { ws.send(JSON.stringify(['REQ', subId, sub.filter])) } catch { /* ignore */ }
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
	/**
	 * @returns {void}
	 */
	const start = () => {
		session.reconnectTimer = null
		if (!isLiveSharedSession(relayUrl, session) || session.connecting || session.ws) return
		if (!session.subs.size) {
			sharedRelaySessions.delete(relayUrl)
			return
		}
		session.connecting = true
		void connectRelay(relayUrl, NOSTR_CONNECT_TIMEOUT_MS).then(ws => {
			session.connecting = false
			if (!isLiveSharedSession(relayUrl, session) || !session.subs.size) {
				if (!session.subs.size && isLiveSharedSession(relayUrl, session))
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
			if (!session.subs.size) {
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
		subs: new Map(),
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
	const ws = session.ws
	if (ws?.readyState === WebSocket.OPEN)
		try { ws.send(JSON.stringify(['CLOSE', subscriptionId])) } catch { /* ignore */ }
	if (session.subs.size) return
	sharedRelaySessions.delete(relayUrl)
	clearSharedRelayReconnect(session)
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
	const ws = session.ws
	if (ws?.readyState !== WebSocket.OPEN) return
	try { ws.send(JSON.stringify(['REQ', subscriptionId, filter])) } catch { /* ignore */ }
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
		if (typeof options.getRelayUrls === 'function') {
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
		const key = String(roomSecret || '')
		if (!key) return () => { }
		return ensureAdvertSubscription('group:' + key, {
			rendezvousKey: groupRendezvousKey(key),
			roomSecret: key,
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
					[['t', rendezvousKey], ['x', 'advert'], ['d', rendezvousKey]],
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
				[['t', rendezvousKey], ['x', 'signal'], ['p', hash]],
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
			const key = String(roomSecret || '')
			const rendezvousKey = groupRendezvousKey(key)
			const abortController = new AbortController()
			ensureGroupSubscription(key)
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
					[['t', rendezvousKey], ['x', 'advert'], ['d', rendezvousKey]],
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
