import { afterEach, test } from 'node:test'

import { DEFAULT_RTT_MS, DEFAULT_RELAY_URLS, PROBE_STALE_MS, STALE_PENALTY } from '../../discovery/nostr/constants.mjs'
import { assert, assertEquals } from '../helpers/assert.mjs'
import { setupRelayTests } from '../helpers/relay_test_setup.mjs'

const DEFAULT_RELAY = 'wss://nos.lol'
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
	upsertRelay({ url: DEFAULT_RELAY, rttMs: 50, source: 'peer', successCount: 2, monitorCount: 1 })
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
	assertEquals(entry.rttMs, null, 'failure invalidates the previous RTT')
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
	// 缺省 lastProbe（从未探测）等同纪元起点：一样算过期，不能靠 NaN 比较把罚分绕过去。
	assertEquals(computeRelayHealth({ rttMs: 100, successCount: 1 }), 100 * STALE_PENALTY, 'missing lastProbe counts as stale')
	assertEquals(computeRelayHealth({ rttMs: 100, successCount: 1, lastProbe: 0 }), 100 * STALE_PENALTY, 'epoch lastProbe counts as stale')
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

test('publish failure demotes a relay across later probes and bootstrap relays need a successful publish', async () => {
	const { upsertRelay, recordProbeSuccess, recordPublishResult, getPoolByUrl, getWorkingRelays, getListenRelays } = await import('../../discovery/nostr/relays.mjs')
	const { PUBLISH_FAILURE_COOLDOWN_MS } = await import('../../discovery/nostr/constants.mjs')
	await setupRelayTests({ clearSeededRelays: true })
	const url = 'wss://relay.nostr.watch'
	upsertRelay({ url, source: 'nip66' })
	recordProbeSuccess(url, 20)
	assert(!getListenRelays().some(entry => entry.url === url), 'an untested bootstrap is not a publish target')
	const discoveredUrl = 'wss://ordinary-discovery.example.com'
	upsertRelay({ url: discoveredUrl, source: 'nip66' })
	recordProbeSuccess(discoveredUrl, 25)
	assert(getListenRelays().some(entry => entry.url === discoveredUrl), 'ordinary NIP-66 discoveries remain eligible for publish testing')
	recordPublishResult(url, true)
	assert(getListenRelays().some(entry => entry.url === url), 'a bootstrap becomes eligible after accepting a publish')
	recordPublishResult(url, false)
	recordProbeSuccess(url, 15)
	assert(!getWorkingRelays().some(entry => entry.url === url), 'a connectivity probe cannot undo a publish rejection')
	getPoolByUrl().get(url).lastPublishFailure = Date.now() - PUBLISH_FAILURE_COOLDOWN_MS - 1
	assert(getWorkingRelays().some(item => item.url === url), 'the cooldown allows a bounded retry')
	recordPublishResult(url, true)
	assert(getListenRelays().some(entry => entry.url === url), 'a later accepted publish restores listen eligibility')
})

test('failed and stale relays stay retryable but leave working and listen sets', async () => {
	const { upsertRelay, recordProbeFailure, recordProbeSuccess, getPoolByUrl, getWorkingRelays, getListenRelays } = await import('../../discovery/nostr/relays.mjs')
	await setupRelayTests({ clearSeededRelays: true })
	const now = Date.now()
	for (const source of ['public', 'manual', 'nip66']) {
		const url = `wss://${source}.example.com`
		upsertRelay({ url, source, rttMs: 0 })
		recordProbeFailure(url)
		assert(getPoolByUrl().has(url), 'failed relay retained for retry')
		assert(!getWorkingRelays().some(entry => entry.url === url), 'never-successful relay excluded from working')
		assert(!getListenRelays().some(entry => entry.url === url), 'never-successful relay excluded from listen')
		recordProbeSuccess(url, 42)
		assert(getWorkingRelays().some(entry => entry.url === url), 'success restores working relay')
		const entry = getPoolByUrl().get(url)
		entry.lastFailure = entry.lastSuccess - 1
		recordProbeFailure(url)
		assert(!getWorkingRelays().some(entry => entry.url === url), 'latest failure excludes previously successful relay')
		recordProbeSuccess(url, 40)
		entry.lastSuccess = entry.lastProbe = now - PROBE_STALE_MS - 1000
		entry.lastFailure = 0
		assert(!getWorkingRelays().some(item => item.url === url), 'expired success excluded even when pinned')
		assert(!getListenRelays().some(item => item.url === url), 'expired success not advertised')
	}
})

test('stale and newly failed successful pinned relays are excluded', async () => {
	const { upsertRelay, getWorkingRelays, getListenRelays } = await import('../../discovery/nostr/relays.mjs')
	await setupRelayTests({ clearSeededRelays: true })
	const now = Date.now()
	upsertRelay({ url: MANUAL_RELAY, source: 'manual', rttMs: 1, successCount: 15, failureCount: 1, lastSuccess: now - 100, lastFailure: now, lastProbe: now })
	upsertRelay({ url: DEFAULT_RELAY, source: 'public', rttMs: 1, successCount: 15, lastSuccess: now - PROBE_STALE_MS - 1000, lastProbe: now - PROBE_STALE_MS - 1000 })
	assertEquals(getWorkingRelays(), [], 'old successes do not make dead pinned relays working')
	assertEquals(getListenRelays(), [], 'old successes do not make dead pinned relays advertisable')
	const { handshakeTargets } = await import('../../discovery/nostr/selection.mjs')
	assertEquals(handshakeTargets('a'.repeat(64), 0).urls, [], 'empty working set never falls back to dead pins')
})

test('all-failure and invalid RTT values cannot earn the best health score', async () => {
	const { computeRelayHealth } = await import('../../discovery/nostr/relays.mjs')
	const { MAX_RTT_MS, FAILURE_WEIGHT } = await import('../../discovery/nostr/constants.mjs')
	// 同一条 relay：最近一次尝试失败后，旧 RTT 被作废，只剩满额失败罚分。
	const failedAfterSuccess = { rttMs: 1, successCount: 15, failureCount: 1, lastSuccess: 1, lastFailure: 2, lastProbe: Date.now() }
	const liveWorst = { rttMs: MAX_RTT_MS, successCount: 15, lastProbe: Date.now() }
	const failed = computeRelayHealth(failedAfterSuccess)
	assertEquals(failed, MAX_RTT_MS * (1 + FAILURE_WEIGHT), 'a relay whose latest attempt failed ignores its old RTT')
	assert(failed > computeRelayHealth(liveWorst), `worst live relay ${computeRelayHealth(liveWorst)} must beat a failed one ${failed}`)
	assertEquals(computeRelayHealth({ rttMs: 0, successCount: 0, failureCount: 65, lastProbe: Date.now() }), failed, 'never-successful relay ranks with the failed ones')
	assertEquals(computeRelayHealth({ rttMs: 0, lastProbe: Date.now() }), DEFAULT_RTT_MS, 'zero RTT is unknown')
	assertEquals(computeRelayHealth({ rttMs: null, lastProbe: Date.now() }), DEFAULT_RTT_MS, 'null RTT is unknown')
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
	const { loadRelayPool, upsertRelay, getPoolByUrl, recordProbeSuccess, recordPublishResult } = await import('../../discovery/nostr/relays.mjs')
	const { flushRelayStateNow, storage } = await setupRelayTests()
	loadRelayPool()
	upsertRelay({ url: 'wss://persist.example.com', rttMs: 60, source: 'nip66', monitorCount: 2 })
	recordProbeSuccess('wss://persist.example.com', 33)
	recordPublishResult('wss://persist.example.com', false)
	flushRelayStateNow()
	assert(storage.data() != null, 'storage written')
	assert(storage.data().nostrRelays.some(entry => entry.url === 'wss://persist.example.com'))
	// 重新加载：新实例读取同一存储
	const reloaded = loadRelayPool()
	const persisted = reloaded.find(entry => entry.url === 'wss://persist.example.com')
	assert(persisted?.lastPublishFailure > 0, 'publish failure state persisted')
	// 发布失败按探测失败记账：lastFailure 落盘、rtt 作废（与被探测失败作废是同一条规则）。
	assert(persisted?.lastFailure > 0, 'probe failure state persisted')
	assertEquals(persisted?.rttMs, null, 'failed attempt invalidates the stored RTT')
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
