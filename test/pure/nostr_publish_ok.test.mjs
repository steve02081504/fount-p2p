import { createServer } from 'node:http'
import { test } from 'node:test'

import { WebSocketServer } from 'ws'

import {
	NOSTR_ADVERT_KIND,
} from '../../discovery/nostr.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { identity } from '../helpers/identity.mjs'

/**
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
async function startFakeRelay(accept = () => true) {
	const server = createServer()
	const wss = new WebSocketServer({ server })
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

	wss.on('connection', ws => {
		connectionCount++
		sockets.add(ws)
		flushOpenWaiters()
		ws.on('message', raw => {
			let parsed
			try { parsed = JSON.parse(String(raw)) } catch { return }
			if (parsed?.[0] === 'REQ') {
				reqCount++
				flushReqWaiters()
				return
			}
			if (parsed?.[0] !== 'EVENT') return
			const event = parsed[1]
			const ok = accept(String(event?.id || ''))
			ws.send(JSON.stringify(['OK', event.id, ok, ok ? '' : 'blocked: test']))
		})
		ws.on('close', () => {
			sockets.delete(ws)
			flushCloseWaiters()
		})
	})
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
	const address = server.address()
	const port = typeof address === 'object' && address ? address.port : 0
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
		async waitOpen(n = 1) {
			while (connectionCount < n)
				await new Promise(resolve => openWaiters.push(resolve))
		},
		/**
		 * @param {number} n 至少多少条 REQ
		 * @returns {Promise<void>}
		 */
		async waitReqs(n) {
			while (reqCount < n)
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
			await new Promise(resolve => wss.close(() => resolve()))
			await new Promise(resolve => server.close(() => resolve()))
		},
	}
}

test('NOSTR advert kind uses addressable range', () => {
	assertEquals(NOSTR_ADVERT_KIND >= 30000 && NOSTR_ADVERT_KIND < 40000, true)
})

test('publishEvent accepts relay OK true', async () => {
	const { createNostrDiscoveryProvider } = await import('../../discovery/nostr.mjs')
	const local = identity(71)
	const relay = await startFakeRelay(() => true)
	const provider = createNostrDiscoveryProvider({ relayUrls: [`ws://127.0.0.1:${relay.port}`] })
	try {
		await provider.sendNodeSignal(local.nodeHash, new Uint8Array([1, 2, 3]))
	}
	finally {
		provider.dispose?.()
		await relay.stop()
	}
})

test('publishEvent rejects when relay OK false', async () => {
	const { createNostrDiscoveryProvider } = await import('../../discovery/nostr.mjs')
	const local = identity(72)
	const relay = await startFakeRelay(() => false)
	const provider = createNostrDiscoveryProvider({ relayUrls: [`ws://127.0.0.1:${relay.port}`] })
	try {
		let threw = false
		try {
			await provider.sendNodeSignal(local.nodeHash, new Uint8Array([1, 2, 3]))
		}
		catch {
			threw = true
		}
		assertEquals(threw, true)
	}
	finally {
		provider.dispose?.()
		await relay.stop()
	}
})

test('shared relay multiplexes signal and advert on one socket', async () => {
	const { createNostrDiscoveryProvider } = await import('../../discovery/nostr.mjs')
	const local = identity(73)
	const peer = identity(74)
	const relay = await startFakeRelay()
	const provider = createNostrDiscoveryProvider({ relayUrls: [`ws://127.0.0.1:${relay.port}`] })
	try {
		const stopSignal = await provider.listenNodeSignals(local.nodeHash, () => { })
		await provider.listVisibleNodeHashes()
		await provider.connectToNode(peer.nodeHash)
		await relay.waitReqs(3)
		assertEquals(relay.connectionCount(), 1)
		assertEquals(relay.openCount(), 1)
		assertEquals(relay.reqCount(), 3)

		stopSignal()
		assertEquals(relay.openCount(), 1)
		assertEquals(relay.reqCount(), 3)
	}
	finally {
		provider.dispose?.()
		await relay.stop()
	}
})

test('shared relay reconnects active subscriptions after drop', async () => {
	const { createNostrDiscoveryProvider } = await import('../../discovery/nostr.mjs')
	const local = identity(75)
	const relay = await startFakeRelay()
	const provider = createNostrDiscoveryProvider({ relayUrls: [`ws://127.0.0.1:${relay.port}`] })
	try {
		await provider.listenNodeSignals(local.nodeHash, () => { })
		await relay.waitReqs(1)
		assertEquals(relay.connectionCount(), 1)

		relay.dropAll()
		await relay.waitOpen(2)
		await relay.waitReqs(2)
		assertEquals(relay.openCount(), 1)
		assertEquals(relay.reqCount() >= 2, true)
	}
	finally {
		provider.dispose?.()
		await relay.stop()
	}
})

test('shared relay closes socket when last subscription ends', async () => {
	const { createNostrDiscoveryProvider } = await import('../../discovery/nostr.mjs')
	const local = identity(76)
	const relay = await startFakeRelay()
	const provider = createNostrDiscoveryProvider({ relayUrls: [`ws://127.0.0.1:${relay.port}`] })
	try {
		const stopSignal = await provider.listenNodeSignals(local.nodeHash, () => { })
		await relay.waitReqs(1)
		assertEquals(relay.openCount(), 1)
		stopSignal()
		await relay.waitClosed()
		assertEquals(relay.openCount(), 0)
	}
	finally {
		provider.dispose?.()
		await relay.stop()
	}
})

test('watchNodeAdvert releases shared relay when last listener ends', async () => {
	const { createNostrDiscoveryProvider } = await import('../../discovery/nostr.mjs')
	const peer = identity(77)
	const relay = await startFakeRelay()
	const provider = createNostrDiscoveryProvider({ relayUrls: [`ws://127.0.0.1:${relay.port}`] })
	try {
		const stop = await provider.watchNodeAdvert(peer.nodeHash, () => { })
		await relay.waitReqs(1)
		assertEquals(relay.openCount(), 1)
		stop()
		await relay.waitClosed()
		assertEquals(relay.openCount(), 0)
	}
	finally {
		provider.dispose?.()
		await relay.stop()
	}
})

test('connectToNode holds advert sub after watch listener ends', async () => {
	const { createNostrDiscoveryProvider } = await import('../../discovery/nostr.mjs')
	const peer = identity(78)
	const relay = await startFakeRelay()
	const provider = createNostrDiscoveryProvider({ relayUrls: [`ws://127.0.0.1:${relay.port}`] })
	try {
		await provider.connectToNode(peer.nodeHash)
		const stop = await provider.watchNodeAdvert(peer.nodeHash, () => { })
		await relay.waitReqs(1)
		stop()
		assertEquals(relay.openCount(), 1)
		provider.dispose?.()
		await relay.waitClosed()
		assertEquals(relay.openCount(), 0)
	}
	finally {
		provider.dispose?.()
		await relay.stop()
	}
})
