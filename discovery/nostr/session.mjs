import { randomBytes } from 'node:crypto'

import WebSocket from 'ws'

import { base64ToBytes } from '../../core/bytes_codec.mjs'
import { nodeDebug } from '../../node/log.mjs'

/** 单中继 WebSocket 首连超时（短超时 + 并行，避免串行 10s×N）。 */
export const NOSTR_CONNECT_TIMEOUT_MS = 2_000
/** 先 close，超时未 CLOSED 再 terminate（给对端优雅关闭的窗口）。 */
const NOSTR_CLOSE_GRACE_MS = 1_000
/** 单 relay 等待 EVENT OK 回执超时。 */
const NOSTR_PUBLISH_OK_TIMEOUT_MS = 3_000
/** 共享 relay 会话断线后重连间隔。 */
const NOSTR_RECONNECT_DELAY_MS = 500
/** 无 sub/publish 工作时共享 relay 空闲回收延迟（给连续 send 复用窗口）。 */
const NOSTR_IDLE_DROP_MS = 2_000

/**
 * @param {string[] | undefined | null} urls 原始列表
 * @returns {string[]} 去重后的列表
 */
export function dedupeRelayUrls(urls) {
	const seen = new Set()
	return (urls || [])
		.map(url => String(url || ''))
		.filter(url => url && !seen.has(url) && (seen.add(url), true))
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
 * @param {string} relayUrl 中继 URL
 * @param {number} [timeoutMs] 超时毫秒
 * @param {AbortSignal} [signal] 取消信号
 * @returns {Promise<import('ws').WebSocket>} 已打开的 WebSocket
 */
export function connectRelay(relayUrl, timeoutMs = NOSTR_CONNECT_TIMEOUT_MS, signal) {
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
	return session.subs.size || session.pendingPublishes.length || session.inflightPublishes.length
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
export function publishViaSharedRelay(relayUrl, event, signal) {
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
export function subscribeNostrKind(relayUrls, options) {
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
