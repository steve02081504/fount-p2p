package io.github.steve02081504.fountp2p.transport

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 等价 `test/pure/peer_health.test.mjs`。
 */
class PeerHealthTest {
	private val peer = "a".repeat(64)

	private class MockRegistry : PeerHealthRegistry {
		val upListeners = LinkedHashSet<(String, PeerHealthLink?) -> Unit>()
		val downListeners = LinkedHashSet<(String) -> Unit>()

		override fun onLinkUp(listener: (String, PeerHealthLink?) -> Unit): () -> Unit {
			upListeners.add(listener)
			return { upListeners.remove(listener) }
		}

		override fun onLinkDown(listener: (String) -> Unit): () -> Unit {
			downListeners.add(listener)
			return { downListeners.remove(listener) }
		}

		fun emitUp(nodeHash: String, link: PeerHealthLink?) {
			for (listener in upListeners.toList()) listener(nodeHash, link)
		}

		fun emitDown(nodeHash: String) {
			for (listener in downListeners.toList()) listener(nodeHash)
		}
	}

	private class MockLink : PeerHealthLink {
		override val providerId: String = "mock"
		private val rttListeners = LinkedHashSet<() -> Unit>()
		private val downListeners = LinkedHashSet<(String?) -> Unit>()

		override fun stats(): Map<String, Any?> = linkedMapOf("rttMs" to 42.0, "avgRttMs" to 40.0)

		override fun onRtt(callback: () -> Unit): () -> Unit {
			rttListeners.add(callback)
			return { rttListeners.remove(callback) }
		}

		override fun onDown(callback: (String?) -> Unit): () -> Unit {
			downListeners.add(callback)
			return { downListeners.remove(callback) }
		}

		fun emitRtt() {
			for (listener in rttListeners.toList()) listener()
		}

		fun emitDown() {
			for (listener in downListeners.toList()) listener("remote-hangup")
		}
	}

	private class Fixture {
		val registry = MockRegistry()
		val link = MockLink()
		val tracker = createPeerHealthTracker(registry)
	}

	@Test
	fun `peer health link up registers connected entry with source`() {
		val fixture = Fixture()
		fixture.registry.emitUp(peer, fixture.link)
		val entry = fixture.tracker.getPeerHealth(peer)!!
		assertEquals(peer, entry.nodeHash)
		assertEquals(true, entry.connected)
		assertNull(entry.rttMs)
		assertNull(entry.avgRttMs)
		assertEquals(true, entry.lastSeenAt > 0)
		assertEquals("mock", entry.source)
	}

	@Test
	fun `peer health onRtt updates rttMs avgRttMs lastSeenAt`() {
		val fixture = Fixture()
		fixture.registry.emitUp(peer, fixture.link)
		val lastSeenAtBeforeRtt = fixture.tracker.getPeerHealth(peer)!!.lastSeenAt
		Thread.sleep(5)
		fixture.link.emitRtt()
		val entry = fixture.tracker.getPeerHealth(peer)!!
		assertEquals(42.0, entry.rttMs!!, 0.0)
		assertEquals(40.0, entry.avgRttMs!!, 0.0)
		assertEquals(true, entry.lastSeenAt > lastSeenAtBeforeRtt)
	}

	@Test
	fun `peer health link down marks disconnected and keeps last record`() {
		val fixture = Fixture()
		fixture.registry.emitUp(peer, fixture.link)
		fixture.link.emitRtt()
		fixture.link.emitDown()
		val entry = fixture.tracker.getPeerHealth(peer)!!
		assertEquals(false, entry.connected)
		assertEquals(42.0, entry.rttMs!!, 0.0)
		assertEquals(true, entry.lastSeenAt >= 0)
	}

	@Test
	fun `peer health registry onLinkDown also marks disconnected`() {
		val fixture = Fixture()
		fixture.registry.emitUp(peer, fixture.link)
		fixture.registry.emitDown(peer)
		assertEquals(false, fixture.tracker.getPeerHealth(peer)!!.connected)
	}

	@Test
	fun `peer health listPeerHealth returns public entries without cleanup field`() {
		val fixture = Fixture()
		fixture.registry.emitUp(peer, fixture.link)
		val list = fixture.tracker.listPeerHealth()
		assertEquals(1, list.size)
		assertEquals(peer, list[0].nodeHash)
		assertFalse(PeerHealthEntry::class.java.declaredFields.any { it.name == "_cleanup" })
	}

	@Test
	fun `peer health onPeerHealth notifies on changes`() {
		val fixture = Fixture()
		val seen = ArrayList<String>()
		val unsubscribe = fixture.tracker.onPeerHealth { nodeHash, entry -> seen.add("$nodeHash:${entry.connected}") }
		fixture.registry.emitUp(peer, fixture.link)
		fixture.link.emitDown()
		assertEquals(listOf("$peer:true", "$peer:false"), seen)
		unsubscribe()
	}

	@Test
	fun `peer health unknown node returns null and stop clears entries`() {
		val fixture = Fixture()
		assertNull(fixture.tracker.getPeerHealth(peer))
		fixture.registry.emitUp(peer, fixture.link)
		fixture.tracker.stop()
		assertEquals(0, fixture.tracker.listPeerHealth().size)
	}
}
