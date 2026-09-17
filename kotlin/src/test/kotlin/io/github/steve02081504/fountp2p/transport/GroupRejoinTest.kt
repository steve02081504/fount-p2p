package io.github.steve02081504.fountp2p.transport

import io.github.steve02081504.fountp2p.discovery.clearDiscoveryProviders
import io.github.steve02081504.fountp2p.discovery.registerDiscoveryProvider
import io.github.steve02081504.fountp2p.identity
import io.github.steve02081504.fountp2p.node.withTempNode
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 等价 `js/test/pure/group_rejoin.test.mjs`。
 */
class GroupRejoinTest {
	@Test
	fun `group link set leave then start rejoins active and subscriptions`() = runBlocking {
		withTempNode("fount-p2p-rejoin-") { _ ->
			clearDiscoveryProviders()
			val mock = MockDiscoveryProvider()
			registerDiscoveryProvider(mock)
			val self = identity(51)
			val peer = identity(52)
			val registry = FakeGroupRegistry(fakeLocalIdentity(self))
			val group = createGroupLinkSet(
				"rejoin",
				GroupLinkSetOptions(
					roomSecret = "rejoin-room",
					members = listOf(self.nodeHash, peer.nodeHash),
					registry = registry,
					autoconnect = false,
				),
			)
			try {
				registry.ensureRuntime()
				group.start()
				assertEquals(true, group.isActive())
				assertEquals(1, mock.watchedGroupSecrets.size)
				group.leave()
				assertEquals(false, group.isActive())
				group.start()
				assertEquals(true, group.isActive())
				assertTrue(
					"expected watch re-subscribed after rejoin, got ${mock.watchedGroupSecrets.size}",
					mock.watchedGroupSecrets.size >= 2,
				)
			}
			finally {
				group.leave()
				clearDiscoveryProviders()
			}
		}
	}
}
