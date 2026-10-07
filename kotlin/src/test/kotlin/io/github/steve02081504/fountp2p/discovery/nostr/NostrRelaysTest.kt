package io.github.steve02081504.fountp2p.discovery.nostr

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 等价 `test/pure/nostr_relays.test.mjs`。 */
class NostrRelaysTest {
	private val defaultRelay = "wss://nos.lol"
	private val manualRelay = "wss://manual.example.com"

	private class MemoryStorage {
		var data: Any? = null
	}

	private fun setupRelayTests(clearSeededRelays: Boolean = false): MemoryStorage {
		val storage = MemoryStorage()
		setRelayStorageIOForTests(object : RelayStorageIO {
			override fun read(): Any? = storage.data
			override fun write(data: Any?) {
				storage.data = data
			}
		})
		loadRelayPool()
		if (clearSeededRelays) clearRelayPoolForTests()
		return storage
	}

	@Test
	fun `normalizeNostrRelayUrl accepts wss and loopback ws rejects others`() {
		assertEquals("wss://relay.damus.io", normalizeNostrRelayUrl("WSS://RELAY.DAMUS.IO/"))
		assertEquals("wss://relay.damus.io", normalizeNostrRelayUrl("wss://relay.damus.io:443"))
		assertEquals("wss://relay.damus.io/foo/bar", normalizeNostrRelayUrl("wss://relay.damus.io/foo/bar/"))
		assertEquals("ws://127.0.0.1:9999", normalizeNostrRelayUrl("ws://127.0.0.1:9999"))
		assertEquals("ws://localhost:9999", normalizeNostrRelayUrl("ws://localhost:9999"))
		assertNull(normalizeNostrRelayUrl("ws://public.example.com"))
		assertNull(normalizeNostrRelayUrl("http://relay.damus.io"))
		assertNull(normalizeNostrRelayUrl("not a url"))
		assertNull(normalizeNostrRelayUrl(""))
	}

	@Test
	fun `loadRelayPool seeds public defaults when empty`() {
		setupRelayTests()
		val pool = loadRelayPool()
		assertTrue(pool.isNotEmpty())
		assertTrue(pool.all { it.source == "public" })
		assertTrue(getListenRelays().isNotEmpty())
	}

	@Test
	fun `upsertRelay dedupes and merges by url keeps higher source priority`() {
		setupRelayTests()
		loadRelayPool()
		upsertRelay(mapOf("url" to defaultRelay, "rttMs" to 50, "source" to "peer", "successCount" to 2, "monitorCount" to 1))
		val entry = getPoolByUrl()[defaultRelay]!!
		assertEquals("public", entry.source)
		assertEquals(2, entry.successCount)
		assertEquals(1, entry.monitorCount)
		upsertRelay(mapOf("url" to "wss://new.example.com", "rttMs" to 30, "source" to "manual"))
		assertEquals(DEFAULT_RELAY_URLS.size + 1, getPoolByUrl().size)
		assertEquals("manual", getPoolByUrl()["wss://new.example.com"]!!.source)
		upsertRelay(mapOf("url" to "wss://new.example.com", "source" to "peer"))
		assertEquals("manual", getPoolByUrl()["wss://new.example.com"]!!.source)
	}

	@Test
	fun `recordProbeSuccess and recordProbeFailure update stats and rtt`() {
		setupRelayTests()
		upsertRelay(mapOf("url" to "wss://probe.example.com", "source" to "nip66"))
		recordProbeSuccess("wss://probe.example.com", 42)
		recordProbeSuccess("wss://probe.example.com", 55)
		recordProbeFailure("wss://probe.example.com")
		val entry = getPoolByUrl()["wss://probe.example.com"]!!
		assertEquals(2, entry.successCount)
		assertEquals(1, entry.failureCount)
		assertNull(entry.rttMs)
		assertTrue(entry.lastProbe > 0)
	}

	@Test
	fun `computeRelayHealth applies failure weight and stale penalty`() {
		val fresh = computeRelayHealth(
			RelayPoolEntry("wss://f", 100.0, 10, 0, 0, 0, System.currentTimeMillis(), 0, 0, "nip66", emptyList(), true, 0),
		)
		val lossy = computeRelayHealth(
			RelayPoolEntry("wss://l", 100.0, 5, 5, 0, 0, System.currentTimeMillis(), 0, 0, "nip66", emptyList(), true, 0),
		)
		assertTrue(lossy > fresh)
		val stale = computeRelayHealth(
			RelayPoolEntry("wss://s", 100.0, 10, 0, 0, 0, System.currentTimeMillis() - (PROBE_STALE_MS + 3600 * 1000), 0, 0, "nip66", emptyList(), true, 0),
		)
		assertTrue(stale > fresh * 1.9)
		val defaultRtt = computeRelayHealth(
			RelayPoolEntry("wss://d", null, 0, 0, 0, 0, System.currentTimeMillis(), 0, 0, "nip66", emptyList(), true, 0),
		)
		assertEquals(DEFAULT_RTT_MS.toDouble(), defaultRtt, 1e-9)
	}

	@Test
	fun `getWorkingRelays and getListenRelays honor caps and force include public manual`() {
		setupRelayTests()
		for (i in 0 until WORKING_RELAYS_COUNT + 4)
			upsertRelay(mapOf("url" to "wss://pool-$i.example.com", "rttMs" to 10 + i, "source" to "nip66"))
		upsertRelay(mapOf("url" to manualRelay, "source" to "manual", "rttMs" to 5))
		val working = getWorkingRelays()
		val listen = getListenRelays()
		assertTrue(working.size <= WORKING_RELAYS_COUNT)
		assertTrue(working.any { it.url == manualRelay })
		assertTrue(listen.any { it.url == manualRelay })
		assertTrue(listen.size <= maxOf(LISTEN_RELAYS_COUNT, 1))
		assertTrue(listen.any { it.url == defaultRelay })
	}

	@Test
	fun `publish rejection survives later probes and bootstrap needs a successful publish`() {
		setupRelayTests(clearSeededRelays = true)
		val url = "wss://relay.nostr.watch"
		upsertRelay(mapOf("url" to url, "source" to "nip66"))
		recordProbeSuccess(url, 20)
		assertTrue("unverified bootstrap is not a publish target", getListenRelays().none { it.url == url })
		val discoveredUrl = "wss://ordinary-discovery.example.com"
		upsertRelay(mapOf("url" to discoveredUrl, "source" to "nip66"))
		recordProbeSuccess(discoveredUrl, 25)
		assertTrue("ordinary NIP-66 discoveries remain eligible for publish testing", getListenRelays().any { it.url == discoveredUrl })
		recordPublishResult(url, true)
		assertTrue("accepted bootstrap enters listen set", getListenRelays().any { it.url == url })
		recordPublishResult(url, false)
		recordProbeSuccess(url, 15)
		assertTrue("connectivity probe cannot undo a publish rejection", getWorkingRelays().none { it.url == url })
		getPoolByUrl()[url]!!.lastPublishFailure = System.currentTimeMillis() - PUBLISH_FAILURE_COOLDOWN_MS - 1
		assertTrue("cooldown permits bounded retry", getWorkingRelays().any { it.url == url })
		recordPublishResult(url, true)
		assertTrue("later accepted publish restores listen eligibility", getListenRelays().any { it.url == url })
	}

	@Test
	fun `failed and stale relays stay retryable but leave working and listen sets`() {
		setupRelayTests(clearSeededRelays = true)
		val now = System.currentTimeMillis()
		for (source in listOf("public", "manual", "nip66")) {
			val url = "wss://$source.example.com"
			upsertRelay(mapOf("url" to url, "source" to source, "rttMs" to 0))
			recordProbeFailure(url)
			assertTrue("failed relay retained for retry", getPoolByUrl().containsKey(url))
			assertTrue("never-successful relay excluded from working", getWorkingRelays().none { it.url == url })
			assertTrue("never-successful relay excluded from listen", getListenRelays().none { it.url == url })
			recordProbeSuccess(url, 42)
			assertTrue("success restores working relay", getWorkingRelays().any { it.url == url })
			val entry = getPoolByUrl()[url]!!
			entry.lastFailure = entry.lastSuccess - 1
			recordProbeFailure(url)
			assertTrue("latest failure excludes previously successful relay", getWorkingRelays().none { it.url == url })
			recordProbeSuccess(url, 40)
			entry.lastSuccess = now - PROBE_STALE_MS - 1000
			entry.lastProbe = entry.lastSuccess
			entry.lastFailure = 0
			assertTrue("expired success excluded even when pinned", getWorkingRelays().none { it.url == url })
			assertTrue("expired success not advertised", getListenRelays().none { it.url == url })
		}
	}

	@Test
	fun `stale and newly failed successful pinned relays are excluded`() {
		setupRelayTests(clearSeededRelays = true)
		val now = System.currentTimeMillis()
		upsertRelay(mapOf("url" to manualRelay, "source" to "manual", "rttMs" to 1, "successCount" to 15, "failureCount" to 1, "lastSuccess" to now - 100, "lastFailure" to now, "lastProbe" to now))
		upsertRelay(mapOf("url" to defaultRelay, "source" to "public", "rttMs" to 1, "successCount" to 15, "lastSuccess" to now - PROBE_STALE_MS - 1000, "lastProbe" to now - PROBE_STALE_MS - 1000))
		assertTrue("old successes do not make dead pinned relays working", getWorkingRelays().isEmpty())
		assertTrue("old successes do not make dead pinned relays advertisable", getListenRelays().isEmpty())
		assertEquals(emptyList<String>(), handshakeTargets("a".repeat(64), 0)["urls"])
	}

	@Test
	fun `all failure and invalid RTT values cannot earn the best health score`() {
		fun entry(rtt: Double?, successes: Int = 0, failures: Int = 0, success: Long = 0, failure: Long = 0, probe: Long = System.currentTimeMillis()) =
			RelayPoolEntry("wss://health", rtt, successes, failures, success, failure, probe, 0, 0, "nip66", emptyList(), true, 0)
		// 同一条 relay：最近一次尝试失败后，旧 RTT 被作废，只剩满额失败罚分。
		val failed = computeRelayHealth(entry(1.0, 15, 1, 1, 2))
		assertEquals(MAX_RTT_MS.toDouble() * (1 + FAILURE_WEIGHT), failed, 1e-9)
		assertTrue("the worst live relay must beat a failed one", failed > computeRelayHealth(entry(MAX_RTT_MS.toDouble(), 15)))
		assertEquals(failed, computeRelayHealth(entry(0.0, failures = 65)), 1e-9)
		assertEquals(DEFAULT_RTT_MS.toDouble(), computeRelayHealth(entry(0.0)), 1e-9)
		assertEquals(DEFAULT_RTT_MS.toDouble(), computeRelayHealth(entry(null)), 1e-9)
		// 纪元起点的 lastProbe（从未探测）一样算过期：不能靠缺省时间戳把罚分绕过去。
		assertEquals(100.0 * STALE_PENALTY, computeRelayHealth(entry(100.0, 1, probe = 0)), 1e-9)
	}

	@Test
	fun `clearStale removes stale non pinned but keeps public manual`() {
		setupRelayTests()
		upsertRelay(mapOf("url" to "wss://stale.example.com", "source" to "nip66"))
		upsertRelay(mapOf("url" to manualRelay, "source" to "manual"))
		val staleEntry = getPoolByUrl()["wss://stale.example.com"]!!
		staleEntry.lastSeen = System.currentTimeMillis() - 48L * 3600 * 1000
		clearStale()
		assertEquals(false, getPoolByUrl().containsKey("wss://stale.example.com"))
		assertEquals(true, getPoolByUrl().containsKey(manualRelay))
		assertEquals(true, getPoolByUrl().containsKey(defaultRelay))
	}

	@Test
	fun `pool persists to storage and reload round trips`() {
		val storage = setupRelayTests()
		loadRelayPool()
		upsertRelay(mapOf("url" to "wss://persist.example.com", "rttMs" to 60, "source" to "nip66", "monitorCount" to 2))
		recordProbeSuccess("wss://persist.example.com", 33)
		recordPublishResult("wss://persist.example.com", true)
		recordPublishResult("wss://persist.example.com", false)
		// A later connectivity probe restores RTT without erasing publish outcome timestamps.
		recordProbeSuccess("wss://persist.example.com", 34)
		flushRelayStateNow()
		assertNotNull(storage.data)
		val relays = (storage.data as Map<*, *>)["nostrRelays"] as List<*>
		val persisted = relays.first { (it as Map<*, *>)["url"] == "wss://persist.example.com" } as Map<*, *>
		assertTrue((persisted["lastPublishSuccess"] as Number).toLong() > 0)
		assertTrue((persisted["lastPublishFailure"] as Number).toLong() > 0)
		val reloaded = loadRelayPool()
		val restored = reloaded.first { it.url == "wss://persist.example.com" }
		assertEquals(34.0, restored.rttMs)
		assertTrue(restored.lastPublishSuccess > 0)
		assertTrue(restored.lastPublishFailure > 0)
	}

	@Test
	fun `pool cap evicts worst non pinned beyond POOL_CAP`() {
		setupRelayTests()
		for (i in 0 until POOL_CAP + 10)
			upsertRelay(mapOf("url" to "wss://cap-$i.example.com", "rttMs" to i, "source" to "nip66"))
		assertTrue(getPoolByUrl().size <= POOL_CAP)
	}
}
