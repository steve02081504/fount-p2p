import { afterEach, test } from 'node:test'

import { DEFAULT_RELAY_URLS } from '../../discovery/nostr/relays.mjs'
import { DEFAULT_RTT_MS, PROBE_STALE_MS } from '../../discovery/nostr/constants.mjs'
import { assert, assertEquals } from '../helpers/assert.mjs'
import { setupRelayTests } from '../helpers/relay_test_setup.mjs'

const DEFAULT_RELAY = 'wss://relay.damus.io'
const MANUAL_RELAY = 'wss://manual.example.com'

test('normalizeNostrRelayUrl accepts wss and loopback ws, rejects others', async () => {
	const { normalizeNostrRelayUrl } = await import('../../discovery/nostr/relays.mjs')
	assertEquals(normalizeNostrRelayUrl('WSS://RELAY.DAMUS.IO/'), 'wss://relay.damus.io')
	assertEquals(normalizeNostrRelayUrl('wss://relay.damus.io:443'), 'wss://relay.damus.io')
	assertEquals(normalizeNostrRelayUrl('wss://relay.damus.io/foo/bar/'), 'wss://relay.damus.io/foo/bar')
	assertEquals(normalizeNostrRelayUrl('ws://127.0.0.1:9999'), 'ws://127.0.0.1:9999')
	assertEquals(normalizeNostrRelayUrl('ws://localhost:9999'), 'ws://localhost:9999')
	assertEquals(normalizeNostrRelayUrl('ws://public.example.com'), null)
	assertEquals(normalizeNostrRelayUrl('http://relay.damus.io'), null)
	assertEquals(normalizeNostrRelayUrl('not a url'), null)
	assertEquals(normalizeNostrRelayUrl(''), null)
})

test('loadRelayPool seeds public defaults when empty', async () => {
	const { loadRelayPool, getListenRelays } = await import('../../discovery/nostr/relays.mjs')
	await setupRelayTests()
	const pool = loadRelayPool()
	assert(pool.length > 0, 'pool seeded')
	assert(pool.every(entry => entry.source === 'public'), 'all seeds are public')
	assert(getListenRelays().length > 0, 'listen non-empty after seed')
})

test('upsertRelay dedupes and merges by url, keeps higher source priority', async () => {
	const { upsertRelay, getPoolByUrl, loadRelayPool } = await import('../../discovery/nostr/relays.mjs')
	await setupRelayTests()
	loadRelayPool()
	upsertRelay({ url: 'wss://relay.damus.io', rttMs: 50, source: 'peer', successCount: 2, monitorCount: 1 })
	const entry = getPoolByUrl().get(DEFAULT_RELAY)
	assertEquals(entry.source, 'public', 'public outranks peer')
	assertEquals(entry.successCount, 2, 'stats merged')
	assertEquals(entry.monitorCount, 1)
	upsertRelay({ url: 'wss://new.example.com', rttMs: 30, source: 'manual' })
	assertEquals(getPoolByUrl().size, DEFAULT_RELAY_URLS.length + 1, 'manual adds new url')
	assertEquals(getPoolByUrl().get('wss://new.example.com').source, 'manual')
	upsertRelay({ url: 'wss://new.example.com', source: 'peer' })
	assertEquals(getPoolByUrl().get('wss://new.example.com').source, 'manual', 'manual kept over peer')
})

test('recordProbeSuccess / recordProbeFailure update stats and rtt', async () => {
	const { upsertRelay, recordProbeSuccess, recordProbeFailure, getPoolByUrl } = await import('../../discovery/nostr/relays.mjs')
	await setupRelayTests()
	upsertRelay({ url: 'wss://probe.example.com', source: 'nip66' })
	recordProbeSuccess('wss://probe.example.com', 42)
	recordProbeSuccess('wss://probe.example.com', 55)
	recordProbeFailure('wss://probe.example.com')
	const entry = getPoolByUrl().get('wss://probe.example.com')
	assertEquals(entry.successCount, 2)
	assertEquals(entry.failureCount, 1)
	assertEquals(entry.rttMs, 55, 'latest rtt wins')
	assert(entry.lastProbe > 0)
})

test('computeRelayHealth applies failure weight and stale penalty', async () => {
	const { computeRelayHealth } = await import('../../discovery/nostr/relays.mjs')
	const fresh = computeRelayHealth({ rttMs: 100, successCount: 10, failureCount: 0, lastProbe: Date.now() })
	const lossy = computeRelayHealth({ rttMs: 100, successCount: 5, failureCount: 5, lastProbe: Date.now() })
	assert(lossy > fresh, 'failure rate inflates score')
	const stale = computeRelayHealth({ rttMs: 100, successCount: 10, failureCount: 0, lastProbe: Date.now() - (PROBE_STALE_MS + 3600 * 1000) })
	assert(stale > fresh * 1.9, 'stale penalty doubles score')
	const defaultRtt = computeRelayHealth({ successCount: 0, failureCount: 0, lastProbe: Date.now() })
	assertEquals(defaultRtt, DEFAULT_RTT_MS, 'missing rtt defaults to 300')
})

test('getWorkingRelays / getListenRelays honor caps and force-include public/manual', async () => {
	const { upsertRelay, getWorkingRelays, getListenRelays } = await import('../../discovery/nostr/relays.mjs')
	const { WORKING_RELAYS_COUNT, LISTEN_RELAYS_COUNT } = await import('../../discovery/nostr/constants.mjs')
	await setupRelayTests()
	for (let i = 0; i < WORKING_RELAYS_COUNT + 4; i++)
		upsertRelay({ url: `wss://pool-${i}.example.com`, rttMs: 10 + i, source: 'nip66' })
	upsertRelay({ url: MANUAL_RELAY, source: 'manual', rttMs: 5 })
	const working = getWorkingRelays()
	const listen = getListenRelays()
	assert(working.length <= WORKING_RELAYS_COUNT, 'working capped')
	assert(working.some(entry => entry.url === MANUAL_RELAY), 'manual forced into working')
	assert(listen.some(entry => entry.url === MANUAL_RELAY), 'manual forced into listen')
	assert(listen.length <= Math.max(LISTEN_RELAYS_COUNT, 1), 'listen capped')
	assert(listen.some(entry => entry.url === DEFAULT_RELAY), 'public seed in listen')
})

test('clearStale removes stale non-pinned but keeps public/manual', async () => {
	const { upsertRelay, clearStale, getPoolByUrl, recordProbeSuccess } = await import('../../discovery/nostr/relays.mjs')
	await setupRelayTests()
	upsertRelay({ url: 'wss://stale.example.com', source: 'nip66' })
	upsertRelay({ url: MANUAL_RELAY, source: 'manual' })
	const staleEntry = getPoolByUrl().get('wss://stale.example.com')
	staleEntry.lastSeen = Date.now() - 48 * 3600 * 1000
	clearStale()
	assertEquals(getPoolByUrl().has('wss://stale.example.com'), false)
	assertEquals(getPoolByUrl().has(MANUAL_RELAY), true, 'manual never evicted')
	assertEquals(getPoolByUrl().has(DEFAULT_RELAY), true, 'public never evicted')
})

test('pool persists to storage and reload round-trips', async () => {
	const { loadRelayPool, upsertRelay, getPoolByUrl, recordProbeSuccess } = await import('../../discovery/nostr/relays.mjs')
	const { flushRelayStateNow, storage } = await setupRelayTests()
	loadRelayPool()
	upsertRelay({ url: 'wss://persist.example.com', rttMs: 60, source: 'nip66', monitorCount: 2 })
	recordProbeSuccess('wss://persist.example.com', 33)
	flushRelayStateNow()
	assert(storage.data() != null, 'storage written')
	assert(storage.data().nostrRelays.some(entry => entry.url === 'wss://persist.example.com'))
	// 重新加载：新实例读取同一存储
	const reloaded = loadRelayPool()
	assert(reloaded.some(entry => entry.url === 'wss://persist.example.com' && entry.rttMs === 33), 'stats persisted')
})

test('pool cap evicts worst non-pinned beyond POOL_CAP', async () => {
	const { POOL_CAP } = await import('../../discovery/nostr/constants.mjs')
	const { upsertRelay, getPoolByUrl } = await import('../../discovery/nostr/relays.mjs')
	await setupRelayTests()
	for (let i = 0; i < POOL_CAP + 10; i++)
		upsertRelay({ url: `wss://cap-${i}.example.com`, rttMs: i, source: 'nip66' })
	assert(getPoolByUrl().size <= POOL_CAP, 'pool capped')
})

afterEach(async () => {
	const { resetNostrRelaysForTests } = await import('../../discovery/nostr/relays.mjs')
	resetNostrRelaysForTests()
})
