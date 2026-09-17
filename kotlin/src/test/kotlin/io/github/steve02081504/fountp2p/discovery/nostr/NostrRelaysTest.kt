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
		assertEquals(55.0, entry.rttMs!!, 1e-9)
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
		flushRelayStateNow()
		assertNotNull(storage.data)
		val relays = (storage.data as Map<*, *>)["nostrRelays"] as List<*>
		assertTrue(relays.any { (it as Map<*, *>)["url"] == "wss://persist.example.com" })
		val reloaded = loadRelayPool()
		assertTrue(reloaded.any { it.url == "wss://persist.example.com" && it.rttMs == 33.0 })
	}

	@Test
	fun `pool cap evicts worst non pinned beyond POOL_CAP`() {
		setupRelayTests()
		for (i in 0 until POOL_CAP + 10)
			upsertRelay(mapOf("url" to "wss://cap-$i.example.com", "rttMs" to i, "source" to "nip66"))
		assertTrue(getPoolByUrl().size <= POOL_CAP)
	}
}
