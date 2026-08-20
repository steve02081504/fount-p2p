import { test } from 'node:test'

import {
	NOSTR_ADVERT_KIND,
} from '../../discovery/nostr.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { startFakeRelay } from '../helpers/fake_relay.mjs'
import { identity } from '../helpers/identity.mjs'

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

test('publish reuses one shared relay socket across many sends', async () => {
	const { createNostrDiscoveryProvider } = await import('../../discovery/nostr.mjs')
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
	const { createNostrDiscoveryProvider } = await import('../../discovery/nostr.mjs')
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
