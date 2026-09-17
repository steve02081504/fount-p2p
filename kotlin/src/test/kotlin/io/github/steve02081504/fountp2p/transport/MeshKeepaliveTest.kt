package io.github.steve02081504.fountp2p.transport

import io.github.steve02081504.fountp2p.TestIdentity
import io.github.steve02081504.fountp2p.discovery.clearDiscoveryProviders
import io.github.steve02081504.fountp2p.discovery.registerDiscoveryProvider
import io.github.steve02081504.fountp2p.identity
import io.github.steve02081504.fountp2p.node.mergeNetworkPeerPools
import io.github.steve02081504.fountp2p.node.withTempNode
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 等价 `js/test/pure/mesh_keepalive.test.mjs`。
 */
class MeshKeepaliveTest {
	private val self = identity(1)
	private val peer = identity(2)
	private val other = identity(3)

	private fun localIdentityMap(identity: TestIdentity): Map<String, Any?> = linkedMapOf(
		"nodeHash" to identity.nodeHash,
		"nodePubKey" to identity.nodePubKey,
		"secretKey" to identity.secretKey,
	)

	/** 可关链的假链路。 */
	private class FakeLink(
		private val owner: FakeMeshRegistry,
		private val nodeHash: String,
	) : MeshLink {
		override val providerId: String? = "fake"

		override suspend fun close(reason: String) {
			owner.links.remove(nodeHash)
			owner.notifyDown(nodeHash, reason)
		}
	}

	private class FakeMeshRegistry(
		override val localIdentity: Map<String, Any?>,
		private val ensureFactory: ((FakeMeshRegistry, String) -> MeshLink?)? = null,
	) : MeshRegistry {
		val links = LinkedHashMap<String, MeshLink>()
		val upListeners = LinkedHashSet<(String) -> Unit>()
		val downListeners = LinkedHashSet<(String, String) -> Unit>()
		val dialed = ArrayList<String>()

		override fun listLinks(): List<MeshLinkRef> = links.entries.map { MeshLinkRef(it.key, it.value) }
		override fun getLink(nodeHash: String): MeshLink? = links[nodeHash]

		override suspend fun ensureLinkToNode(nodeHash: String): MeshLink? {
			dialed.add(nodeHash)
			val link = ensureFactory?.invoke(this, nodeHash)
			if (link != null) {
				links[nodeHash] = link
				notifyUp(nodeHash)
			}
			return link
		}

		override fun onLinkUp(listener: (String) -> Unit): () -> Unit {
			upListeners.add(listener)
			return { upListeners.remove(listener); Unit }
		}

		override fun onLinkDown(listener: (String, String) -> Unit): () -> Unit {
			downListeners.add(listener)
			return { downListeners.remove(listener); Unit }
		}

		fun notifyUp(nodeHash: String) {
			for (listener in upListeners.toList()) listener(nodeHash)
		}

		fun notifyDown(nodeHash: String, reason: String) {
			for (listener in downListeners.toList()) listener(nodeHash, reason)
		}
	}

	@Test
	fun `isMeshIntentionalClose covers budget manual shutdown`() {
		assertEquals(true, isMeshIntentionalClose("budget-evict"))
		assertEquals(true, isMeshIntentionalClose("manual-close"))
		assertEquals(true, isMeshIntentionalClose("registry-shutdown"))
		assertEquals(true, isMeshIntentionalClose("inbound-no-nodehash"))
		assertEquals(false, isMeshIntentionalClose("remote-close"))
		assertEquals(false, isMeshIntentionalClose(""))
	}

	@Test
	fun `mesh keepalive intentional close does not redial unexpected down refills via tick`() = runBlocking {
		withTempNode("fount-p2p-mesh-ka-") { _ ->
			clearDiscoveryProviders()
			val mock = MockDiscoveryProvider()
			registerDiscoveryProvider(mock)
			mock.publishAdvert(peer.nodeHash, byteArrayOf(1))
			mock.publishAdvert(other.nodeHash, byteArrayOf(1))

			val registry = FakeMeshRegistry(localIdentityMap(self)) { reg, nodeHash -> FakeLink(reg, nodeHash) }
			val ka = createMeshKeepalive(registry, enabled = true)
			ka.start()
			delay(80)
			assertTrue(registry.dialed.isNotEmpty())
			val afterStart = registry.dialed.size

			registry.links.remove(peer.nodeHash)
			registry.notifyDown(peer.nodeHash, "budget-evict")
			delay(80)
			assertEquals(afterStart, registry.dialed.size)
			assertEquals(false, ka.exploreLinkHashes.contains(peer.nodeHash))

			registry.links.remove(other.nodeHash)
			registry.notifyDown(other.nodeHash, "remote-hangup")
			delay(80)
			assertTrue(registry.dialed.size > afterStart)

			ka.stop()
			clearDiscoveryProviders()
		}
	}

	@Test
	fun `mesh keepalive rebalance tick evicts explore then dials trusted`() = runBlocking {
		withTempNode("fount-p2p-mesh-reb-") { _ ->
			mergeNetworkPeerPools(
				linkedMapOf(
					"trustedPeers" to listOf(peer.nodeHash),
					"explorePeers" to emptyList<String>(),
				),
			)
			clearDiscoveryProviders()

			val exploreHashes = (1..8).map { ("e$it").repeat(32) }
			val evicted = ArrayList<String>()
			val registry = FakeMeshRegistry(localIdentityMap(self)) { reg, nodeHash -> FakeLink(reg, nodeHash) }
			for (hash in exploreHashes) {
				registry.links[hash] = object : MeshLink {
					override suspend fun close(reason: String) {
						evicted.add(hash)
						registry.links.remove(hash)
						registry.notifyDown(hash, reason)
					}
				}
			}

			val ka = createMeshKeepalive(registry, enabled = true)
			for (hash in exploreHashes) ka.exploreLinkHashes.add(hash)
			ka.start()
			delay(150)
			assertTrue(registry.dialed.contains(peer.nodeHash))
			assertTrue(evicted.isNotEmpty())
			assertTrue(registry.links.containsKey(peer.nodeHash))

			ka.stop()
			clearDiscoveryProviders()
		}
	}

	@Test
	fun `mesh keepalive inbound non-trusted marked explore on link up`() = runBlocking {
		withTempNode("fount-p2p-mesh-in-") { _ ->
			clearDiscoveryProviders()
			val registry = FakeMeshRegistry(localIdentityMap(self)) { _, _ -> null }
			val ka = createMeshKeepalive(registry, enabled = true)
			ka.start()
			delay(50)
			registry.links[peer.nodeHash] = FakeLink(registry, peer.nodeHash)
			registry.notifyUp(peer.nodeHash)
			assertEquals(true, ka.exploreLinkHashes.contains(peer.nodeHash))

			ka.stop()
			clearDiscoveryProviders()
		}
	}
}
