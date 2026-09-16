import { createServer } from 'node:http'

import { WebSocketServer } from 'ws'

/**
 * 启动一个内存假 Nostr 中继：记录连接/REQ 数，对 EVENT 回 OK。
 * `options.broadcast` 为 true 时向全部已连接 socket 扇出 EVENT（模拟真实中继）。
 * `options.store` 为 true 时存储已接受事件并在新 REQ 上回放匹配事件 + EOSE（模拟 store-and-forward 中继）。
 * @param {(eventId: string) => boolean} [accept] 是否接受 EVENT
 * @param {{ broadcast?: boolean, store?: boolean }} [options] 中继选项
 * @returns {Promise<{
 *   port: number,
 *   connectionCount: () => number,
 *   openCount: () => number,
 *   reqCount: () => number,
 *   waitOpen: (n?: number) => Promise<void>,
 *   waitReqs: (n: number) => Promise<void>,
 *   waitClosed: () => Promise<void>,
 *   dropAll: () => void,
 *   stop: () => Promise<void>,
 *   publishedEvents: Array<object>,
 * }>} fake relay
 */
export async function startFakeRelay(accept = () => true, options = {}) {
	const { broadcast = false, store = false } = options
	const server = createServer((request, response) => {
		// NIP-11 relay info：响应 JSON，避免 HTTP 探测等待超时；Connection: close 规避 Windows undici keep-alive 退出断言。
		if (request.method === 'GET') {
			response.writeHead(200, { 'Content-Type': 'application/nostr+json', Connection: 'close' })
			response.end(JSON.stringify({ supported_nips: [1, 33], limitation: { max_message_length: 262144 } }))
			return
		}
		response.writeHead(405)
		response.end()
	})
	const webSocketServer = new WebSocketServer({ server })
	/** @type {Array<object>} */
	const publishedEvents = []
	/** @type {Array<object>} */
	const storedEvents = []
	let connectionCount = 0
	let reqCount = 0
	/** @type {Array<() => void>} */
	const openWaiters = []
	/** @type {Array<() => void>} */
	const reqWaiters = []
	/** @type {Array<() => void>} */
	const closeWaiters = []

	/** 唤醒全部 open 等待者 */
	const flushOpenWaiters = () => {
		for (const wake of openWaiters.splice(0)) wake()
	}
	/** 唤醒全部 REQ 等待者 */
	const flushReqWaiters = () => {
		for (const wake of reqWaiters.splice(0)) wake()
	}
	/** 唤醒全部 close 等待者 */
	const flushCloseWaiters = () => {
		for (const wake of closeWaiters.splice(0)) wake()
	}

	/**
	 * 判定 filter 是否匹配事件（支持 kinds 与 #tag 过滤）。
	 * @param {object} filter REQ 过滤器
	 * @param {object} event Nostr 事件
	 * @returns {boolean} 匹配为 true
	 */
	const filterMatchesEvent = (filter, event) => {
		if (Array.isArray(filter?.kinds) && !filter.kinds.includes(event?.kind)) return false
		for (const [key, values] of Object.entries(filter || {})) {
			if (!key.startsWith('#')) continue
			const tagKey = key.slice(1)
			const eventTags = new Set(
				(event?.tags || []).filter(tag => tag?.[0] === tagKey).map(tag => tag[1]),
			)
			if (!Array.isArray(values) || !values.some(value => eventTags.has(value))) return false
		}
		return true
	}

	/** socket → Map<subscriptionId, filter> */
	const subsBySocket = new Map()

	webSocketServer.on('connection', socket => {
		connectionCount++
		subsBySocket.set(socket, new Map())
		flushOpenWaiters()
		socket.on('message', rawMessage => {
			let parsed
			try { parsed = JSON.parse(String(rawMessage)) } catch { return }
			if (parsed?.[0] === 'REQ') {
				reqCount++
				const subscriptionId = String(parsed[1] || '')
				const filter = parsed[2] || {}
				subsBySocket.get(socket)?.set(subscriptionId, filter)
				if (store)
					for (const event of storedEvents)
						if (filterMatchesEvent(filter, event))
							try { socket.send(JSON.stringify(['EVENT', subscriptionId, event])) } catch { /* ignore */ }
				if (store)
					try { socket.send(JSON.stringify(['EOSE', subscriptionId])) } catch { /* ignore */ }
				flushReqWaiters()
				return
			}
			if (parsed?.[0] !== 'EVENT') return
			const event = parsed[1]
			const eventId = String(event?.id || '')
			const ok = accept(eventId)
			socket.send(JSON.stringify(['OK', eventId, ok, ok ? '' : 'blocked: test']))
			if (!ok) return
			publishedEvents.push(event)
			if (store) storedEvents.push(event)
			if (broadcast)
				for (const [subscriber, subs] of subsBySocket)
					for (const [subscriptionId, filter] of subs)
						if (filterMatchesEvent(filter, event))
							try { subscriber.send(JSON.stringify(['EVENT', subscriptionId, event])) } catch { /* ignore */ }
		})
		socket.on('close', () => {
			subsBySocket.delete(socket)
			flushCloseWaiters()
		})
	})
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
	const { port } = server.address()
	return {
		port,
		/**
		 * @returns {number} 累计连接次数
		 */
		connectionCount: () => connectionCount,
		/**
		 * @returns {number} 当前仍打开的 socket 数
		 */
		openCount: () => subsBySocket.size,
		/**
		 * @returns {number} 累计收到的 REQ 数
		 */
		reqCount: () => reqCount,
		/**
		 * @param {number} [n=1] 至少多少条连接
		 * @param {number} expectedCount 预期的连接数
		 * @returns {Promise<void>}
		 */
		async waitOpen(expectedCount = 1) {
			while (connectionCount < expectedCount)
				await new Promise(resolve => openWaiters.push(resolve))
		},
		/**
		 * @param {number} expectedCount 至少多少条 REQ
		 * @returns {Promise<void>}
		 */
		async waitReqs(expectedCount) {
			while (reqCount < expectedCount)
				await new Promise(resolve => reqWaiters.push(resolve))
		},
		/**
		 * @returns {Promise<void>}
		 */
		async waitClosed() {
			while (subsBySocket.size > 0)
				await new Promise(resolve => closeWaiters.push(resolve))
		},
		/** 断开全部已连接 socket */
		dropAll() {
			for (const ws of [...subsBySocket.keys()])
				try { ws.close() } catch { /* ignore */ }
		},
		/**
		 * @returns {Promise<void>}
		 */
		async stop() {
			for (const ws of [...subsBySocket.keys()])
				try { ws.terminate() } catch { /* ignore */ }
			await new Promise(resolve => webSocketServer.close(() => resolve()))
			await new Promise(resolve => server.close(() => resolve()))
		},
		publishedEvents,
	}
}
