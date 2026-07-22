import { randomBytes } from 'node:crypto'

import { schnorr } from '@noble/curves/secp256k1.js'
import WebSocket from 'ws'

import { base64ToBytes, hexToBytes, bytesToBase64, bytesToHex } from '../core/bytes_codec.mjs'
import { isHex64, normalizeHex64 } from '../core/hexIds.mjs'
import { sha256Hex } from '../crypto/crypto.mjs'
import { nodeDebug, shortHash } from '../node/log.mjs'

import { ingestEncryptedAdvert } from './adverts.mjs'
import {
	encryptSignalPacket,
	groupRendezvousKey,
	networkRendezvousKey,
	nodeRendezvousKey,
} from './internal/signal_crypto.mjs'

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

/** Nostr advert 事件 kind。 */
export const NOSTR_ADVERT_KIND = 27235
/** Nostr signal 事件 kind。 */
export const NOSTR_SIGNAL_KIND = 27236

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
 * @param {{ roomSecret?: string }} [options] 带 roomSecret 时写入群池
 * @returns {Promise<string | null>} 验签通过的 nodeHash
 */
export async function acceptNostrAdvert(rendezvousKey, bytes, options = {}) {
	const ingested = await ingestEncryptedAdvert(rendezvousKey, bytes)
	if (!ingested) return null
	const hash = ingested.verifiedNodeHash
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
	if (firstSeen)
		nodeDebug('p2p:nostr peer visible', { peer: shortHash(hash), group: !!roomSecret })
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
			ws.send(JSON.stringify(['EVENT', event]))
			published = true
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
 * @param {string[]} relayUrls 中继列表
 * @param {(ws: import('ws').WebSocket, relayUrl: string) => void} onOpen 连上回调
 * @param {AbortSignal} signal 取消信号
 * @param {import('ws').WebSocket[]} sockets 已打开 socket 收集
 * @returns {void}
 */
function connectRelaysProgressive(relayUrls, onOpen, signal, sockets) {
	for (const relayUrl of relayUrls)
		void connectRelay(relayUrl, NOSTR_CONNECT_TIMEOUT_MS, signal).then(ws => {
			if (signal.aborted) {
				dropWebSocket(ws)
				return
			}
			sockets.push(ws)
			nodeDebug('p2p:nostr relay up', { url: relayUrl })
			onOpen(ws, relayUrl)
		}).catch(error => {
			nodeDebug('p2p:nostr relay fail', {
				url: relayUrl,
				err: String(error?.message || error),
			})
		})
}

/**
 * 内部：按 rendezvous 键订阅 Nostr kind（topic 不导出）。
 * @param {string[]} relayUrls 中继 URL 列表
 * @param {{ kind: number, rendezvousKey: string, tagX: string, onPayload: (bytes: Uint8Array, meta: { relayUrl: string, event: object }) => void | Promise<void> }} options 订阅选项
 * @returns {() => void} 取消订阅
 */
function subscribeNostrKind(relayUrls, options) {
	const { kind, rendezvousKey, tagX, onPayload } = options
	const abortController = new AbortController()
	/** @type {import('ws').WebSocket[]} */
	const sockets = []
	const subscriptionId = randomBytes(8).toString('hex')
	connectRelaysProgressive(relayUrls, (ws, relayUrl) => {
		ws.on('message', data => {
			if (abortController.signal.aborted) return
			let parsed
			try { parsed = JSON.parse(String(data)) } catch { return }
			if (parsed?.[0] !== 'EVENT') return
			const nostrEvent = parsed[2]
			if (nostrEvent?.kind !== kind) return
			try {
				const result = onPayload(base64ToBytes(nostrEvent.content), { relayUrl, event: nostrEvent })
				if (result?.then) void result.catch(() => { })
			}
			catch { /* ignore */ }
		})
		ws.send(JSON.stringify(['REQ', subscriptionId, { kinds: [kind], '#t': [rendezvousKey], '#x': [tagX] }]))
	}, abortController.signal, sockets)
	return () => {
		abortController.abort()
		for (const ws of sockets) dropWebSocket(ws)
	}
}

/**
 * 创建 Nostr discovery provider（list+connect；topic 仅内部）。
 * @param {{ relayUrls?: string[] | null, getRelayUrls?: () => string[] | null | undefined }} [options] 中继配置
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
	/** @type {(() => void) | null} */
	let stopNetworkAdvertSub = null
	/** @type {Map<string, () => void>} */
	const groupSubs = new Map()
	/** @type {Map<string, () => void>} */
	const nodeAdvertSubs = new Map()
	/** @type {Map<string, () => void>} */
	const nodeSignalSubs = new Map()

	/**
	 * @returns {void}
	 */
	function ensureNetworkAdvertSubscription() {
		if (stopNetworkAdvertSub) return
		const rendezvousKey = networkRendezvousKey()
		stopNetworkAdvertSub = subscribeNostrKind(resolveRelayUrls(), {
			kind: NOSTR_ADVERT_KIND,
			rendezvousKey,
			tagX: 'advert',
			/**
			 * @param {Uint8Array} bytes 加密 advert 载荷
			 * @returns {Promise<void>}
			 */
			async onPayload(bytes) {
				await acceptNostrAdvert(rendezvousKey, bytes)
			},
		})
	}

	/**
	 * @param {string} roomSecret 房间密钥
	 * @returns {void}
	 */
	function ensureGroupSubscription(roomSecret) {
		const key = String(roomSecret || '')
		if (!key || groupSubs.has(key)) return
		const rendezvousKey = groupRendezvousKey(key)
		groupSubs.set(key, subscribeNostrKind(resolveRelayUrls(), {
			kind: NOSTR_ADVERT_KIND,
			rendezvousKey,
			tagX: 'advert',
			/**
			 * @param {Uint8Array} bytes 加密 advert 载荷
			 * @returns {Promise<void>}
			 */
			async onPayload(bytes) {
				await acceptNostrAdvert(rendezvousKey, bytes, { roomSecret: key })
			},
		}))
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
				return listNostrGroupVisibleNodeHashes(options.roomSecret).slice(0, limit)
			}
			ensureNetworkAdvertSubscription()
			return listNostrVisibleNodeHashes().slice(0, limit)
		},
		/**
		 * 挂上对该节点的内部 advert 订阅（建链由 registry dialer / ensureLinkToNode 完成）。
		 * @param {string} nodeHash 目标
		 * @returns {Promise<boolean>} 是否已准备
		 */
		async connectToNode(nodeHash) {
			const hash = normalizeHex64(nodeHash)
			if (!isHex64(hash)) return false
			if (!nodeAdvertSubs.has(hash)) {
				const rendezvousKey = nodeRendezvousKey(hash)
				nodeAdvertSubs.set(hash, subscribeNostrKind(resolveRelayUrls(), {
					kind: NOSTR_ADVERT_KIND,
					rendezvousKey,
					tagX: 'advert',
					/**
					 * @param {Uint8Array} bytes 加密 advert 载荷
					 * @returns {Promise<void>}
					 */
					async onPayload(bytes) {
						await acceptNostrAdvert(rendezvousKey, bytes)
					},
				}))
			}
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
				noteNostrVisibleNode(beacon.nodeHash)
				const advertBody = beacon.advertBody || beacon.body || beacon
				const bytes = encryptSignalPacket(rendezvousKey, { type: 'advert', body: advertBody })
				const event = await signNostrEvent(
					NOSTR_ADVERT_KIND,
					[['t', rendezvousKey], ['x', 'advert']],
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
			const rendezvousKey = nodeRendezvousKey(hash)
			const stop = subscribeNostrKind(resolveRelayUrls(), {
				kind: NOSTR_ADVERT_KIND,
				rendezvousKey,
				tagX: 'advert',
				/**
				 * @param {Uint8Array} bytes 加密 advert 载荷
				 * @param {object} meta relay 元数据
				 * @returns {void}
				 */
				onPayload: (bytes, meta) => onAdvert(bytes, meta),
			})
			return stop
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
				noteNostrGroupVisibleNode(key, beacon.nodeHash)
				const advertBody = beacon.advertBody || beacon.body || beacon
				const bytes = encryptSignalPacket(rendezvousKey, { type: 'advert', body: advertBody })
				const event = await signNostrEvent(
					NOSTR_ADVERT_KIND,
					[['t', rendezvousKey], ['x', 'advert']],
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
			const key = String(roomSecret || '')
			const rendezvousKey = groupRendezvousKey(key)
			ensureGroupSubscription(key)
			return subscribeNostrKind(resolveRelayUrls(), {
				kind: NOSTR_ADVERT_KIND,
				rendezvousKey,
				tagX: 'advert',
				/**
				 * @param {Uint8Array} bytes 加密 advert 载荷
				 * @param {object} meta relay 元数据
				 * @returns {void}
				 */
				onPayload: (bytes, meta) => onAdvert(bytes, meta),
			})
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
			stopNetworkAdvertSub?.()
			stopNetworkAdvertSub = null
			for (const stop of groupSubs.values())
				try { stop() } catch { /* ignore */ }
			groupSubs.clear()
			for (const stop of nodeAdvertSubs.values())
				try { stop() } catch { /* ignore */ }
			nodeAdvertSubs.clear()
			for (const stop of nodeSignalSubs.values())
				try { stop() } catch { /* ignore */ }
			nodeSignalSubs.clear()
		},
	}
}
