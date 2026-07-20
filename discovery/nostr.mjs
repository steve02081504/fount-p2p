import { randomBytes } from 'node:crypto'

import { schnorr } from '@noble/curves/secp256k1.js'
import WebSocket from 'ws'

import { base64ToBytes, hexToBytes, bytesToBase64, bytesToHex } from '../core/bytes_codec.mjs'
import { sha256Hex } from '../crypto/crypto.mjs'

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

/**
 * 关掉 WebSocket：已连上则先 close，grace 内未 CLOSED 再 terminate。
 * 连接中直接 terminate（无握手可优雅收尾）。
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
	// Grace is polite to the peer; must not pin the process after shutdown.
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
 * 去重并清洗中继 URL 列表。
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
 * 合并默认与用户配置的中继 URL（去重）。
 * @param {string[] | undefined | null} userRelayUrls 用户自定义中继列表
 * @returns {string[]} 合并后的中继 URL 列表
 */
export function mergeSignalingRelayUrls(userRelayUrls) {
	const merged = dedupeRelayUrls([...DEFAULT_RELAY_URLS, ...userRelayUrls || []])
	return merged.length ? merged : [...DEFAULT_RELAY_URLS]
}

/**
 * 签名 Nostr 事件。
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
 * 连接 Nostr 中继 WebSocket（`ws` 包，支持 terminate）。
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
 * 向多个中继并行发布 Nostr 事件（任一成功即可）。
 * @param {string[]} relayUrls 中继 URL 列表
 * @param {object} event 待发布事件
 * @param {AbortSignal} [signal] 取消信号
 * @returns {Promise<void>}
 */
async function publishEvent(relayUrls, event, signal) {
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
 * 并行渐进连接中继：立刻返回，连上后回调；abort 后 stop 接入并 drop 已开 socket。
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
			onOpen(ws, relayUrl)
		}).catch(() => { /* 单路失败正常降级 */ })
}

/**
 * 订阅指定 kind 的 Nostr 事件（渐进连中继，立即返回 cleanup）。
 * @param {string[]} relayUrls 中继 URL 列表
 * @param {{ kind: number, topic: string, tagX: string, onPayload: (bytes: Uint8Array, meta: { relayUrl: string, event: object }) => void }} options 订阅选项
 * @returns {() => void} 取消订阅
 */
function subscribeNostrKind(relayUrls, options) {
	const { kind, topic, tagX, onPayload } = options
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
			try { onPayload(base64ToBytes(nostrEvent.content), { relayUrl, event: nostrEvent }) }
			catch { /* ignore */ }
		})
		ws.send(JSON.stringify(['REQ', subscriptionId, { kinds: [kind], '#t': [topic], '#x': [tagX] }]))
	}, abortController.signal, sockets)
	return () => {
		abortController.abort()
		for (const ws of sockets) dropWebSocket(ws)
	}
}

/**
 * 创建 Nostr discovery provider。
 * subscribe/onSignal/advertise 首调用不阻塞等公网中继；连上后渐进生效。
 * `options.relayUrls` 为最终列表（调用方 `mergeSignalingRelayUrls`，或直接传入 `relayOverride`）。
 * 省略 / `undefined` → 默认公网中继；显式 `[]` 表示无中继（不再回填默认）。
 * @param {{ relayUrls?: string[] | null }} [options] 可选最终中继 URL 列表
 * @returns {import('./index.mjs').DiscoveryProvider} Nostr 发现提供者
 */
export function createNostrDiscoveryProvider(options = {}) {
	const relayUrls = dedupeRelayUrls(options.relayUrls || DEFAULT_RELAY_URLS)
	const secretKey = randomBytes(32)
	return {
		id: 'nostr',
		priority: 100,
		caps: { canDiscover: true, canSignal: true, canRelay: false },
		/**
		 * 周期性向中继发布 advert 事件（首发后台，不阻塞 ensureRuntime）。
		 * @param {string} topic advert 主题
		 * @param {Uint8Array} bytes advert 载荷
		 * @returns {Promise<() => void>} 取消广播函数
		 */
		async advertise(topic, bytes) {
			const abortController = new AbortController()
			/**
			 * 向中继发布当前 advert。
			 * @returns {Promise<void>}
			 */
			const publish = async () => {
				if (abortController.signal.aborted) return
				const event = await signNostrEvent(
					NOSTR_ADVERT_KIND,
					[['t', topic], ['x', 'advert']],
					bytesToBase64(bytes),
					secretKey,
				)
				await publishEvent(relayUrls, event, abortController.signal)
			}
			void publish().catch(() => { })
			const timer = setInterval(() => { void publish().catch(() => { }) }, 5 * 60_000)
			return () => {
				abortController.abort()
				clearInterval(timer)
			}
		},
		/**
		 * 订阅中继上的 advert 事件（并行渐进连中继，立即返回 cleanup）。
		 * @param {string} topic advert 主题
		 * @param {Function} onAdvert advert 回调
		 * @returns {Promise<() => void>} 取消订阅函数
		 */
		async subscribe(topic, onAdvert) {
			return subscribeNostrKind(relayUrls, {
				kind: NOSTR_ADVERT_KIND,
				topic,
				tagX: 'advert',
				onPayload: onAdvert,
			})
		},
		/**
		 * 向中继发布 signal 事件（按需发送，仍等待至少一路成功）。
		 * @param {string} topic 信令 topic
		 * @param {string} to 目标节点标识
		 * @param {Uint8Array} bytes 信令载荷
		 * @returns {Promise<void>}
		 */
		async sendSignal(topic, to, bytes) {
			const event = await signNostrEvent(
				NOSTR_SIGNAL_KIND,
				[['t', topic], ['x', 'signal'], ['p', String(to || '')]],
				bytesToBase64(bytes),
				secretKey,
			)
			await publishEvent(relayUrls, event)
		},
		/**
		 * 订阅中继上的 signal 事件（并行渐进连中继，立即返回 cleanup）。
		 * @param {string} topic 信令 topic
		 * @param {Function} onSignal 信令回调
		 * @returns {Promise<() => void>} 取消订阅函数
		 */
		async onSignal(topic, onSignal) {
			return subscribeNostrKind(relayUrls, {
				kind: NOSTR_SIGNAL_KIND,
				topic,
				tagX: 'signal',
				onPayload: onSignal,
			})
		},
	}
}
