package io.github.steve02081504.fountp2p.discovery.nostr

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** 等价 `test/pure/nostr_relay_selection.test.mjs`。 */
class NostrRelaySelectionTest {
	private fun setupRelayTests(): MemoryStorage {
		val storage = MemoryStorage()
		setRelayStorageIOForTests(object : RelayStorageIO {
			override fun read(): Any? = storage.data
			override fun write(data: Any?) {
				storage.data = data
			}
		})
		loadRelayPool()
		return storage
	}

	private class MemoryStorage {
		var data: Any? = null
	}

	@Test
	fun `backoffDelay exponentiates and caps`() {
		assertEquals(0L, backoffDelay(0))
		assertEquals(2000L, backoffDelay(1))
		assertEquals(4000L, backoffDelay(2))
		assertEquals(8000L, backoffDelay(3))
		assertEquals(60000L, backoffDelay(10))
	}

	@Test
	fun `handshakeTargets round 0 prefers peer listen relays then local working`() {
		setupRelayTests()
		setPeerRoute(
			"11".repeat(32),
			mapOf(
				"listenRelays" to listOf(
					"wss://peer-1.example.com",
					"wss://peer-2.example.com",
					"wss://peer-3.example.com",
					"wss://peer-4.example.com",
					"wss://peer-5.example.com",
				),
				"peerPool" to listOf(mapOf("url" to "wss://peer-1.example.com", "rttMs" to 10)),
			),
		)
		val urls = handshakeTargets("11".repeat(32), 0)["urls"] as List<*>
		assertEquals(4, urls.size)
		assertEquals("wss://peer-1.example.com", urls[0])
		val fallback = handshakeTargets("22".repeat(32), 0)["urls"] as List<*>
		assertTrue("fallback ${fallback.size} within [3,4]", fallback.size in 3..4)
		assertTrue(fallback.all { it.toString().startsWith("wss://") })
	}

	@Test
	fun `weightedRandomSample biases toward low rtt relays`() {
		val entries = listOf(
			RelayPoolEntry("wss://fast.example.com", 10.0, 0, 0, 0, 0, System.currentTimeMillis(), 0, 0, "nip66", emptyList(), true, 0),
			RelayPoolEntry("wss://slow.example.com", 500.0, 0, 0, 0, 0, System.currentTimeMillis(), 0, 0, "nip66", emptyList(), true, 0),
		)
		val seen = HashSet<String>()
		var fastCount = 0
		var slowCount = 0
		for (i in 0 until 200) {
			val picks = weightedRandomSample(entries, 1)
			seen.add(picks[0])
			if (picks[0] == "wss://fast.example.com") fastCount++ else slowCount++
		}
		assertTrue(seen.contains("wss://fast.example.com"))
		assertTrue("fast($fastCount) should dominate slow($slowCount)", fastCount >= slowCount)
		assertTrue(seen.size <= 2)
	}

	@Test
	fun `expandFromHistory fills from history then peer reach then working`() {
		setupRelayTests()
		setPeerRoute(
			"33".repeat(32),
			mapOf(
				"listenRelays" to listOf("wss://peer-a.example.com"),
				"lastGoodNostrRelays" to listOf("wss://hist-1.example.com", "wss://hist-2.example.com"),
			),
		)
		val out = expandFromHistory("33".repeat(32), listOf("wss://hist-1.example.com", "wss://hist-2.example.com"), 5)
		assertTrue(out.contains("wss://hist-1.example.com"))
		assertTrue(out.contains("wss://hist-2.example.com"))
		assertTrue(out.contains("wss://peer-a.example.com"))
		assertTrue(out.size <= 5)
		assertTrue(getReachPeerRelays("33".repeat(32)).size >= 1)
	}

	@Test
	fun `handshakeTargets round 1 plus expands from lastGood and caps fanout`() {
		setupRelayTests()
		val history = (0 until 40).map { "wss://hist-$it.example.com" }
		setPeerRoute(
			"44".repeat(32),
			mapOf(
				"listenRelays" to history.take(8),
				"lastGoodNostrRelays" to history,
			),
		)
		val urls = handshakeTargets("44".repeat(32), 1)["urls"] as List<*>
		assertTrue(urls.size <= MAX_ROUTING_FANOUT)
		assertTrue(urls.contains("wss://hist-0.example.com"))
		assertTrue(urls.contains("wss://hist-7.example.com"))
	}

	@Test
	fun `routePublishEvent returns false with no targets`() = runBlocking {
		setupRelayTests()
		clearRelayPoolForTests()
		val ok = routePublishEvent("55".repeat(32), mapOf("id" to "a".repeat(64)))
		assertEquals(false, ok)
		assertEquals(0, getPeerRoute("55".repeat(32))?.lastGoodNostrRelays?.size ?: 0)
	}
}
