import { test } from 'node:test'

import { assert, assertEquals } from '../helpers/assert.mjs'
import { setupRelayTests } from '../helpers/relay_test_setup.mjs'

test('backoffDelay exponentiates and caps', async () => {
	const { backoffDelay } = await import('../../discovery/nostr/selection.mjs')
	assertEquals(backoffDelay(0), 0)
	assertEquals(backoffDelay(1), 2000)
	assertEquals(backoffDelay(2), 4000)
	assertEquals(backoffDelay(3), 8000)
	assertEquals(backoffDelay(10), 60000, 'capped')
})

test('handshakeTargets round 0 prefers peer listen relays then local working', async () => {
	const { relays } = await setupRelayTests()
	const selection = await import('../../discovery/nostr/selection.mjs')
	relays.setPeerRoute('11'.repeat(32), { listenRelays: ['wss://peer-1.example.com', 'wss://peer-2.example.com', 'wss://peer-3.example.com', 'wss://peer-4.example.com', 'wss://peer-5.example.com'], peerPool: [{ url: 'wss://peer-1.example.com', rttMs: 10 }] })
	const { urls } = selection.handshakeTargets('11'.repeat(32), 0)
	assertEquals(urls.length, 4, 'peer listen first 4')
	assertEquals(urls[0], 'wss://peer-1.example.com', 'lowest composite first')
	// 无对端数据时取本机 working 前 4（种子池 3 条 public）
	const { urls: fallback } = selection.handshakeTargets('22'.repeat(32), 0)
	assert(fallback.length >= 3 && fallback.length <= 4, `fallback ${fallback.length} within [3,4]`)
	assert(fallback.every(url => url.startsWith('wss://')), 'from local pool')
})

test('weightedRandomSample biases toward low-rtt relays', async () => {
	const { weightedRandomSample } = await import('../../discovery/nostr/selection.mjs')
	const entries = [
		{ url: 'wss://fast.example.com', rttMs: 10, successCount: 0, failureCount: 0, lastProbe: Date.now() },
		{ url: 'wss://slow.example.com', rttMs: 500, successCount: 0, failureCount: 0, lastProbe: Date.now() },
	]
	const seen = new Set()
	let fastCount = 0
	let slowCount = 0
	for (let i = 0; i < 200; i++) {
		const picks = weightedRandomSample(entries, 1)
		seen.add(picks[0])
		if (picks[0] === 'wss://fast.example.com') fastCount++
		else slowCount++
	}
	assert(seen.has('wss://fast.example.com'), 'fast relay sampled')
	assert(fastCount >= slowCount, `fast(${fastCount}) should dominate slow(${slowCount})`)
	assert(seen.size <= 2)
})

test('expandFromHistory fills from history then peer reach then working', async () => {
	const { relays } = await setupRelayTests()
	const { expandFromHistory, getReachPeerRelays } = await import('../../discovery/nostr/selection.mjs')
	relays.setPeerRoute('33'.repeat(32), {
		listenRelays: ['wss://peer-a.example.com'],
		lastGoodNostrRelays: ['wss://hist-1.example.com', 'wss://hist-2.example.com'],
	})
	const out = expandFromHistory('33'.repeat(32), ['wss://hist-1.example.com', 'wss://hist-2.example.com'], 5)
	assert(out.includes('wss://hist-1.example.com'))
	assert(out.includes('wss://hist-2.example.com'))
	assert(out.includes('wss://peer-a.example.com'))
	assert(out.length <= 5)
	assert(getReachPeerRelays('33'.repeat(32)).length >= 1)
})

test('handshakeTargets round 1+ expands from lastGood and caps fanout', async () => {
	const { relays } = await setupRelayTests()
	const { MAX_ROUTING_FANOUT } = await import('../../discovery/nostr/constants.mjs')
	const { handshakeTargets } = await import('../../discovery/nostr/selection.mjs')
	// 历史 40 条 + 对端 listen
	const history = Array.from({ length: 40 }, (_, i) => `wss://hist-${i}.example.com`)
	relays.setPeerRoute('44'.repeat(32), {
		listenRelays: history.slice(0, 8),
		lastGoodNostrRelays: history,
	})
	const { urls } = handshakeTargets('44'.repeat(32), 1)
	assert(urls.length <= MAX_ROUTING_FANOUT, 'fanout capped')
	assert(urls.includes('wss://hist-0.example.com'))
	assert(urls.includes('wss://hist-7.example.com'))
})

test('routePublishEvent returns false with no targets', async () => {
	const { relays } = await setupRelayTests()
	relays.clearRelayPoolForTests()
	const { routePublishEvent } = await import('../../discovery/nostr/selection.mjs')
	const ok = await routePublishEvent('55'.repeat(32), { id: 'a'.repeat(64) })
	assertEquals(ok, false)
	assertEquals(relays.getPeerRoute('55'.repeat(32))?.lastGoodNostrRelays?.length ?? 0, 0)
})
