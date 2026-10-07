import { createServer } from 'node:http'
import { test } from 'node:test'

import {
	NOSTR_ADVERT_KIND,
	createNostrDiscoveryProvider,
} from '../../discovery/nostr/index.mjs'
import { clearDiscoveryProviders, registerDiscoveryProvider } from '../../discovery/index.mjs'
import { setQueuedPublishDeadlineMsForTests } from '../../discovery/nostr/session.mjs'
import { createNostrLinkProvider } from '../../link/providers/nostr/index.mjs'
import { clearLinkProviders, registerLinkProvider } from '../../link/providers/index.mjs'
import { createLinkRegistry, setLinkDialDeadlineMsForTests } from '../../transport/link_registry.mjs'
import { assert, assertEquals } from '../helpers/assert.mjs'
import { startFakeRelay } from '../helpers/fake_relay.mjs'
import { identity } from '../helpers/identity.mjs'

/**
 * 轮询等待发布结果落盘到 relay 池：本地假 relay 的 OK 延迟可能晚于 `sendNodeSignal` 返回。
 * @param {() => boolean} condition 满足即返回
 * @param {number} timeoutMs 等待上限
 * @returns {Promise<void>}
 */
async function waitForPublishOutcome(condition, timeoutMs = 2_000) {
	const deadline = Date.now() + timeoutMs
	while (!condition()) {
		if (Date.now() >= deadline) throw new Error('timed out waiting for relay publish outcome')
		await new Promise(resolve => setTimeout(resolve, 10))
	}
}

/**
 * 启动一个「接受 TCP 连接但永不完 WebSocket 握手」的假 relay：
 * 复现 DNS 能解析、WS 却永远连不上的 relay（fount-p2p#37）。
 * @returns {Promise<{ url: string, stop: () => Promise<void> }>} 悬挂 relay
 */
async function startHungRelay() {
	const held = new Set()
	const server = createServer(() => { /* 不回任何响应：WS 握手永远不完成 */ })
	server.on('connection', socket => {
		held.add(socket)
		socket.on('close', () => held.delete(socket))
	})
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
	const { port } = server.address()
	return {
		url: `ws://127.0.0.1:${port}`,
		/**
		 * @returns {Promise<void>}
		 */
		async stop() {
			for (const socket of [...held]) {
				held.delete(socket)
				socket.destroy()
			}
			await new Promise(resolve => server.close(() => resolve()))
		},
	}
}

test('NOSTR advert kind uses addressable range', () => {
	assertEquals(NOSTR_ADVERT_KIND >= 30000 && NOSTR_ADVERT_KIND < 40000, true)
})

test('publishEvent accepts relay OK true', async () => {
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

test('publish succeeds when a fast rejection races a slower accepting relay and records both outcomes', async () => {
	const peer = identity(91)
	const rejecting = await startFakeRelay(() => false)
	const accepting = await startFakeRelay(() => true, { okDelayMs: 80 })
	const rejectUrl = `ws://127.0.0.1:${rejecting.port}`
	const acceptUrl = `ws://127.0.0.1:${accepting.port}`
	const provider = createNostrDiscoveryProvider({ relayUrls: [rejectUrl, acceptUrl] })
	const { getPoolByUrl } = await import('../../discovery/nostr/relays.mjs')
	try {
		await provider.sendNodeSignal(peer.nodeHash, new Uint8Array([4, 5, 6]))
		const pool = getPoolByUrl()
		assertEquals(pool.get(rejectUrl).lastPublishFailure > 0, true, 'fast rejection is recorded')
		assertEquals(pool.get(acceptUrl).lastPublishSuccess > 0, true, 'slower acceptance is recorded')
	}
	finally {
		provider.dispose?.()
		await rejecting.stop()
		await accepting.stop()
	}
})

test('configured publish timeout demotes the relay', async () => {
	const peer = identity(92)
	const relay = await startFakeRelay(() => true, { okDelayMs: 3_500 })
	const relayUrl = `ws://127.0.0.1:${relay.port}`
	const provider = createNostrDiscoveryProvider({ relayUrls: [relayUrl] })
	const { getPoolByUrl } = await import('../../discovery/nostr/relays.mjs')
	try {
		await assert.rejects(provider.sendNodeSignal(peer.nodeHash, new Uint8Array([1])))
		assertEquals(getPoolByUrl().get(relayUrl).lastPublishFailure > 0, true)
	}
	finally {
		provider.dispose?.()
		await relay.stop()
	}
})

test('publish records a late rejection after an earlier relay already accepted', async () => {
	const peer = identity(93)
	const accepting = await startFakeRelay(() => true)
	// 慢的中继必须真的慢过本机到快中继那一趟：否则「提前返回」无从证明。
	const rejecting = await startFakeRelay(() => false, { okDelayMs: 300 })
	const acceptUrl = `ws://127.0.0.1:${accepting.port}`
	const rejectUrl = `ws://127.0.0.1:${rejecting.port}`
	const provider = createNostrDiscoveryProvider({ relayUrls: [acceptUrl, rejectUrl] })
	const { getPoolByUrl } = await import('../../discovery/nostr/relays.mjs')
	try {
		await provider.sendNodeSignal(peer.nodeHash, new Uint8Array([2]))
		assertEquals(getPoolByUrl().get(acceptUrl).lastPublishSuccess > 0, true)
		assertEquals(getPoolByUrl().get(rejectUrl)?.lastPublishFailure ?? 0, 0, 'the slow relay is still pending when publish already returned')
		await waitForPublishOutcome(() => (getPoolByUrl().get(rejectUrl)?.lastPublishFailure ?? 0) > 0, 5_000)
		assertEquals(getPoolByUrl().get(rejectUrl).lastPublishFailure > 0, true, 'the background attempt settles its own health')
	}
	finally {
		provider.dispose?.()
		await accepting.stop()
		await rejecting.stop()
	}
})

test('publish settles when a relay resolves but never completes the WS connect', async () => {
	const local = identity(85)
	const hung = await startHungRelay()
	setQueuedPublishDeadlineMsForTests(300)
	const provider = createNostrDiscoveryProvider({ relayUrls: [hung.url] })
	try {
		const startedAt = Date.now()
		await assert.rejects(
			provider.sendNodeSignal(local.nodeHash, new Uint8Array([1, 2, 3])),
			error => /connect timeout/.test(String(error?.message ?? error)),
		)
		const elapsedMs = Date.now() - startedAt
		assertEquals(elapsedMs < 5_000, true, `publish settled after ${elapsedMs}ms`)
	}
	finally {
		provider.dispose?.()
		setQueuedPublishDeadlineMsForTests(null)
		await hung.stop()
	}
})

test('publish resolves on the first accepting relay while a pooled relay stays unreachable', async () => {
	const local = identity(86)
	const peer = identity(87)
	const healthy = await startFakeRelay(() => true)
	const hung = await startHungRelay()
	setQueuedPublishDeadlineMsForTests(1_500)
	const provider = createNostrDiscoveryProvider({
		relayUrls: [`ws://127.0.0.1:${healthy.port}`, hung.url],
	})
	try {
		const startedAt = Date.now()
		await provider.sendNodeSignal(peer.nodeHash, new Uint8Array([7, 7, 7]))
		const elapsedMs = Date.now() - startedAt
		assertEquals(healthy.publishedEvents.length, 1)
		assertEquals(elapsedMs < 2_000, true, `publish waited ${elapsedMs}ms for an unreachable pooled relay`)
	}
	finally {
		provider.dispose?.()
		setQueuedPublishDeadlineMsForTests(null)
		await healthy.stop()
		await hung.stop()
	}
})

test('ensureLinkToNode settles and does not poison later dials when a provider stays stuck', async () => {
	const alice = identity(88)
	const bob = identity(89)
	const hung = await startHungRelay()
	// 入队 publish 保持默认上限（远大于 dial 上限），确保是 registry 自己的整体上限在兜底。
	setLinkDialDeadlineMsForTests(1_500)
	clearLinkProviders()
	clearDiscoveryProviders()
	// 显式 relayUrls 让 replace 出的 URL 进入受信集，relay 才会真正尝试连接（而不是被公网校验直接拒掉）。
	const discovery = createNostrDiscoveryProvider({ relayUrls: [hung.url], localNodeHash: alice.nodeHash })
	registerDiscoveryProvider(discovery)
	const nostrLink = createNostrLinkProvider({
		/**
		 * @returns {string[]} relay URL 列表
		 */
		getRelayUrls: () => [hung.url],
	})
	registerLinkProvider(nostrLink)
	const registry = createLinkRegistry({
		localIdentity: alice,
		autoRegisterDiscoveryProviders: false,
		autoRegisterLinkProviders: false,
		meshKeepalive: false,
	})
	try {
		await registry.ensureRuntime()
		const firstStartedAt = Date.now()
		assertEquals(await registry.ensureLinkToNode(bob.nodeHash), null)
		const firstMs = Date.now() - firstStartedAt
		assertEquals(firstMs < 4_000, true, `first dial settled after ${firstMs}ms`)
		const secondStartedAt = Date.now()
		assertEquals(await registry.ensureLinkToNode(bob.nodeHash), null)
		const secondMs = Date.now() - secondStartedAt
		assertEquals(secondMs < 4_000, true, `second dial settled after ${secondMs}ms instead of reusing a stuck dial`)
	}
	finally {
		await registry.shutdown()
		discovery.dispose?.()
		clearLinkProviders()
		clearDiscoveryProviders()
		setLinkDialDeadlineMsForTests(null)
		await hung.stop()
	}
})

test('shared relay multiplexes signal and advert on one socket', async () => {
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

test('publish reuses one shared relay socket across many sends', async () => {
	const local = identity(79)
	const peer = identity(80)
	const relay = await startFakeRelay(() => true)
	const provider = createNostrDiscoveryProvider({ relayUrls: [`ws://127.0.0.1:${relay.port}`] })
	try {
		await provider.listenNodeSignals(local.nodeHash, () => { })
		await relay.waitOpen(1)
		for (let sendIndex = 0; sendIndex < 20; sendIndex++)
			await provider.sendNodeSignal(peer.nodeHash, new Uint8Array([sendIndex]))
		assertEquals(relay.connectionCount(), 1)
		assertEquals(relay.openCount(), 1)
	}
	finally {
		provider.dispose?.()
		await relay.stop()
	}
})

test('publish-only session reuses socket across consecutive sends', async () => {
	const peer = identity(81)
	const relay = await startFakeRelay(() => true)
	const provider = createNostrDiscoveryProvider({ relayUrls: [`ws://127.0.0.1:${relay.port}`] })
	try {
		await provider.sendNodeSignal(peer.nodeHash, new Uint8Array([1]))
		await provider.sendNodeSignal(peer.nodeHash, new Uint8Array([2]))
		assertEquals(relay.connectionCount(), 1)
		assertEquals(relay.openCount(), 1)
	}
	finally {
		provider.dispose?.()
		await relay.stop()
	}
})

test('shared relay reconnects active subscriptions after drop', async () => {
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
