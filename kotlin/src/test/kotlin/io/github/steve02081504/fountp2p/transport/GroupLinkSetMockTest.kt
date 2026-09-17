package io.github.steve02081504.fountp2p.transport

import io.github.steve02081504.fountp2p.discovery.clearDiscoveryProviders
import io.github.steve02081504.fountp2p.discovery.registerDiscoveryProvider
import io.github.steve02081504.fountp2p.identity
import io.github.steve02081504.fountp2p.node.withTempNode
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 等价 `js/test/live/group_link_set_mock.test.mjs`（改用内存 registry broker，无需真实链路）。
 */
class GroupLinkSetMockTest {
	@Test
	fun `group link set discovers via roomSecret scan and carries group envelopes`() = runBlocking {
		withTempNode("fount-p2p-group-mock-") { _ ->
			clearDiscoveryProviders()
			val mock = MockDiscoveryProvider("mock-group-discovery")
			registerDiscoveryProvider(mock)
			val alice = identity(21)
			val bob = identity(22)
			val broker = FakeGroupBroker()
			val aliceRegistry = FakeGroupRegistry(fakeLocalIdentity(alice), broker)
			val bobRegistry = FakeGroupRegistry(fakeLocalIdentity(bob), broker)
			broker.register(aliceRegistry)
			broker.register(bobRegistry)
			val roomSecret = "shared-room-secret"
			val members = listOf(alice.nodeHash, bob.nodeHash)
			val aliceGroup = createGroupLinkSet(
				"g1",
				GroupLinkSetOptions(roomSecret = roomSecret, members = members, registry = aliceRegistry, autoconnect = false),
			)
			val bobGroup = createGroupLinkSet(
				"g1",
				GroupLinkSetOptions(roomSecret = roomSecret, members = members, registry = bobRegistry, autoconnect = false),
			)
			val received = ArrayList<Pair<String, Map<String, Any?>>>()
			val off = bobGroup.onEnvelope { sender, envelope -> received.add(sender to envelope) }
			try {
				aliceRegistry.ensureRuntime()
				bobRegistry.ensureRuntime()
				aliceGroup.start()
				bobGroup.start()
				broker.connect(alice.nodeHash, bob.nodeHash)
				assertEquals(1, aliceGroup.send("dag_event", mapOf("hello" to "group")))
				assertEquals(1, received.size)
				assertEquals(alice.nodeHash, received[0].first)
				assertEquals("group:g1", received[0].second["scope"])
				assertEquals("dag_event", received[0].second["action"])
				assertEquals(mapOf("hello" to "group"), received[0].second["payload"])
			}
			finally {
				off()
				aliceGroup.leave()
				bobGroup.leave()
				clearDiscoveryProviders()
			}
		}
	}
}
