package io.github.steve02081504.fountp2p.transport

import io.github.steve02081504.fountp2p.TestIdentity
import io.github.steve02081504.fountp2p.core.compareHex64Asc
import io.github.steve02081504.fountp2p.identity
import io.github.steve02081504.fountp2p.link.providers.LinkHandle
import io.github.steve02081504.fountp2p.link.providers.LinkProvider
import io.github.steve02081504.fountp2p.link.providers.clearLinkProviders
import io.github.steve02081504.fountp2p.link.providers.registerLinkProvider
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.After
import org.junit.Before
import org.junit.Test

/**
 * 等价 `js/test/live/link_registry_mock.test.mjs`：
 * 用假 bootstrap + 假 link provider 覆盖注册表语义（无需真实 WebRTC/socket）。
 */
class LinkRegistryMockTest {
	private val self = identity(11)
	private val remote = identity(12)

	private fun localIdentityMap(identity: TestIdentity): Map<String, Any?> = linkedMapOf(
		"nodeHash" to identity.nodeHash,
		"nodePubKey" to identity.nodePubKey,
		"secretKey" to identity.secretKey,
	)

	private class FakeLinkHandle(
		override val nodeHash: String?,
		override val initiator: Boolean,
		override val level: Double,
		override val providerId: String,
	) : LinkHandle {
		override val ready: CompletableDeferred<Unit> = CompletableDeferred(Unit)
		private val envelopeListeners = LinkedHashSet<(Map<String, Any?>, String) -> Unit>()
		private val downListeners = LinkedHashSet<(String) -> Unit>()
		var closedReason: String? = null

		override suspend fun send(envelope: Map<String, Any?>): Boolean = true

		override fun onEnvelope(callback: (Map<String, Any?>, String) -> Unit): () -> Unit {
			envelopeListeners.add(callback)
			return { envelopeListeners.remove(callback); Unit }
		}

		override fun onDown(callback: (String) -> Unit): () -> Unit {
			downListeners.add(callback)
			return { downListeners.remove(callback); Unit }
		}

		override fun stats(): Map<String, Any?> = emptyMap()

		override suspend fun close(reason: String) {
			closedReason = reason
			emitDown(reason)
		}

		fun emitEnvelope(envelope: Map<String, Any?>, senderNodeHash: String) {
			for (listener in envelopeListeners.toList()) listener(envelope, senderNodeHash)
		}

		fun emitDown(reason: String) {
			for (listener in downListeners.toList()) listener(reason)
		}
	}

	private class FakeLinkProvider(
		override val id: String,
		override val level: Double,
		private val link: LinkHandle,
	) : LinkProvider {
		override val caps: Map<String, Any?> = mapOf("needsOfferAnswer" to false, "probe" to "sync")
		override suspend fun isAvailable(): Boolean = true
		override suspend fun dial(options: Map<String, Any?>): LinkHandle = link
	}

	private class FakeBootstrap : RuntimeBootstrap {
		override fun isLive(): Boolean = true
		override fun lanTcpPort(): Int? = null
		override fun ownedLanTcp(): LinkProvider? = null
		override fun ownedBleGatt(): LinkProvider? = null
		override suspend fun ensureRuntime() { }
		override suspend fun ensureChannelAvailable(channel: String): Boolean = true
		override suspend fun whenListening() { }
		override suspend fun whenSignalListening() { }
		override suspend fun buildLocalAdvert(scope: Any?): Map<String, Any?> = emptyMap()
		override suspend fun reloadDiscoveryRelays() { }
		override suspend fun shutdown() { }
	}

	@Before
	fun setUp() {
		clearLinkProviders()
		resetLinkRegistryForTests()
	}

	@After
	fun tearDown() {
		clearLinkProviders()
		resetLinkRegistryForTests()
	}

	private fun newRegistry(): LinkRegistry =
		createLinkRegistry(
			LinkRegistryOptions(
				localIdentity = localIdentityMap(self),
				meshKeepalive = false,
				autoRegisterDiscoveryProviders = false,
				autoRegisterLinkProviders = false,
			),
		) { FakeBootstrap() }

	@Test
	fun `link registry dials via provider dispatches scopes and handles down`() = runBlocking {
		val link = FakeLinkHandle(remote.nodeHash, initiator = true, level = 50.0, providerId = "fake")
		registerLinkProvider(FakeLinkProvider("fake", 50.0, link))
		val registry = newRegistry()
		val scoped = ArrayList<Pair<String, Map<String, Any?>>>()
		val up = ArrayList<String>()
		val down = ArrayList<Pair<String, String>>()
		registry.subscribeScope("node") { sender, envelope -> scoped.add(sender to envelope) }
		registry.onLinkUp { nodeHash, _ -> up.add(nodeHash) }
		registry.onLinkDown { nodeHash, reason -> down.add(nodeHash to reason) }
		try {
			assertSame(link, registry.ensureLinkToNode(remote.nodeHash))
			assertSame(link, registry.getLink(remote.nodeHash))
			assertEquals(1, registry.listLinks().size)
			assertEquals(listOf(remote.nodeHash), up)
			assertEquals(true, registry.sendToNodeLink(remote.nodeHash, mapOf("scope" to "node", "action" to "ping", "payload" to mapOf("x" to 1.0))))

			link.emitEnvelope(mapOf("scope" to "node", "action" to "ping", "payload" to mapOf("x" to 1.0)), remote.nodeHash)
			delay(80)
			assertEquals(1, scoped.size)
			assertEquals(remote.nodeHash, scoped[0].first)

			// peer health 记录链路建立。
			assertEquals(true, registry.getPeerHealth(remote.nodeHash)?.connected)

			link.emitDown("remote-close")
			delay(50)
			assertNull(registry.getLink(remote.nodeHash))
			assertEquals(listOf(remote.nodeHash to "remote-close"), down)
			assertEquals(false, registry.getPeerHealth(remote.nodeHash)?.connected)

			// 无链路时 send 走 overlay relay 也失败（无链路）。
			assertEquals(false, registry.sendToNodeLink(remote.nodeHash, mapOf("scope" to "node", "action" to "x", "payload" to null)))
		}
		finally {
			registry.shutdown()
		}
	}

	@Test
	fun `link registry prefers higher level and glare rule`() = runBlocking {
		val link1 = FakeLinkHandle(remote.nodeHash, initiator = true, level = 50.0, providerId = "low")
		registerLinkProvider(FakeLinkProvider("low", 50.0, link1))
		val registry = newRegistry()
		try {
			registry.ensureLinkToNode(remote.nodeHash)
			val higher = FakeLinkHandle(remote.nodeHash, initiator = false, level = 70.0, providerId = "high")
			registry.registerResolvedLink(remote.nodeHash, higher)
			assertSame(higher, registry.getLink(remote.nodeHash))
			assertEquals("provider-replaced", link1.closedReason)

			// 同 level：glare 规则只保留由较小 nodeHash 发起的一条。
			val preferredInitiator = compareHex64Asc(self.nodeHash, remote.nodeHash) < 0
			val glareLoser = FakeLinkHandle(remote.nodeHash, initiator = !preferredInitiator, level = 70.0, providerId = "glare")
			registry.registerResolvedLink(remote.nodeHash, glareLoser)
			assertSame(higher, registry.getLink(remote.nodeHash))
			assertEquals("glare-loser", glareLoser.closedReason)
		}
		finally {
			registry.shutdown()
		}
	}

	@Test
	fun `configureLinkRegistry must run before getLinkRegistry`() = runBlocking {
		configureLinkRegistry(
			LinkRegistryOptions(
				localIdentity = localIdentityMap(self),
				meshKeepalive = false,
				autoRegisterDiscoveryProviders = false,
				autoRegisterLinkProviders = false,
			),
		)
		val registry = getLinkRegistry()
		try {
			var threw = false
			try {
				configureLinkRegistry(LinkRegistryOptions())
			}
			catch (_: IllegalStateException) {
				threw = true
			}
			assertTrue(threw)
		}
		finally {
			registry.shutdown()
			resetLinkRegistryForTests()
		}
	}
}
