package io.github.steve02081504.fountp2p.discovery

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

/** 等价 `test/pure/discovery_connect.test.mjs`。 */
class DiscoveryConnectTest {
	private val remote = "ab".repeat(32)

	@Test
	fun `connectToNode without dialer only prepares and returns false`() = runBlocking {
		clearDiscoveryProviders()
		clearLanPeerHints()
		setDiscoveryLinkDialer(null)
		noteLanPeerHint(remote, LanEndpoint("127.0.0.1", 18080))
		registerDiscoveryProvider(createLanDiscoveryProvider())
		assertEquals(false, connectToNode(remote))
		clearDiscoveryProviders()
		clearLanPeerHints()
	}

	@Test
	fun `connectToNode with dialer delegates prepare to dialer`() = runBlocking {
		clearDiscoveryProviders()
		clearLanPeerHints()
		noteLanPeerHint(remote, LanEndpoint("127.0.0.1", 18080))
		val prepared = ArrayList<String>()
		registerDiscoveryProvider(object : DiscoveryProvider("prep-probe", 1.0) {
			override suspend fun listVisibleNodeHashes(options: Map<String, Any?>): List<String> = emptyList()

			override suspend fun connectToNode(nodeHash: String, options: Map<String, Any?>): Boolean {
				prepared.add(nodeHash)
				return true
			}
		})
		val dialed = ArrayList<String>()
		setDiscoveryLinkDialer { nodeHash ->
			prepareConnectToNode(nodeHash)
			dialed.add(nodeHash)
			mapOf("ok" to true)
		}
		assertEquals(true, connectToNode(remote))
		assertEquals(listOf(remote), prepared)
		assertEquals(listOf(remote), dialed)
		setDiscoveryLinkDialer(null)
		clearDiscoveryProviders()
		clearLanPeerHints()
	}

	@Test
	fun `prepareConnectToNode arms lan when hint exists`() = runBlocking {
		clearDiscoveryProviders()
		clearLanPeerHints()
		noteLanPeerHint(remote, LanEndpoint("10.0.0.2", 9))
		val provider = createLanDiscoveryProvider()
		registerDiscoveryProvider(provider)
		prepareConnectToNode(remote)
		assertEquals(true, provider.connectToNode(remote))
		assertEquals(false, provider.connectToNode("cd".repeat(32)))
		clearDiscoveryProviders()
		clearLanPeerHints()
	}
}
