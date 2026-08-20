import { createServer } from 'node:http'

import { WebSocketServer } from 'ws'

/**
 * 启动一个内存假 Nostr 中继：记录连接/REQ 数，对 EVENT 回 OK。
 * @param {(eventId: string) => boolean} [accept] 是否接受 EVENT
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
 * }>} fake relay
 */
export async function startFakeRelay(accept = () => true) {
	const server = createServer()
	const webSocketServer = new WebSocketServer({ server })
	/** @type {Set<import('ws').WebSocket>} */
	const sockets = new Set()
	let connectionCount = 0
	let reqCount = 0
	/** @type {Array<() => void>} */
	const openWaiters = []
	/** @type {Array<() => void>} */
	const reqWaiters = []
	/** @type {Array<() => void>} */
	const closeWaiters = []

	/**
	 * @returns {void}
	 */
	const flushOpenWaiters = () => {
		for (const wake of openWaiters.splice(0)) wake()
	}
	/**
	 * @returns {void}
	 */
	const flushReqWaiters = () => {
		for (const wake of reqWaiters.splice(0)) wake()
	}
	/**
	 * @returns {void}
	 */
	const flushCloseWaiters = () => {
		for (const wake of closeWaiters.splice(0)) wake()
	}

	webSocketServer.on('connection', socket => {
		connectionCount++
		sockets.add(socket)
		flushOpenWaiters()
		socket.on('message', rawMessage => {
			let parsed
			try { parsed = JSON.parse(String(rawMessage)) } catch { return }
			if (parsed?.[0] === 'REQ') {
				reqCount++
				flushReqWaiters()
				return
			}
			if (parsed?.[0] !== 'EVENT') return
			const event = parsed[1]
			const ok = accept(String(event?.id || ''))
			socket.send(JSON.stringify(['OK', event.id, ok, ok ? '' : 'blocked: test']))
		})
		socket.on('close', () => {
			sockets.delete(socket)
			flushCloseWaiters()
		})
	})
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
	const port = server.address().port
	return {
		port,
		/**
		 * @returns {number} 累计连接次数
		 */
		connectionCount: () => connectionCount,
		/**
		 * @returns {number} 当前仍打开的 socket 数
		 */
		openCount: () => sockets.size,
		/**
		 * @returns {number} 累计收到的 REQ 数
		 */
		reqCount: () => reqCount,
		/**
		 * @param {number} [n=1] 至少多少条连接
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
			while (sockets.size > 0)
				await new Promise(resolve => closeWaiters.push(resolve))
		},
		/**
		 * @returns {void}
		 */
		dropAll() {
			for (const ws of [...sockets])
				try { ws.close() } catch { /* ignore */ }
		},
		/**
		 * @returns {Promise<void>}
		 */
		async stop() {
			for (const ws of [...sockets])
				try { ws.terminate() } catch { /* ignore */ }
			await new Promise(resolve => webSocketServer.close(() => resolve()))
			await new Promise(resolve => server.close(() => resolve()))
		},
	}
}
