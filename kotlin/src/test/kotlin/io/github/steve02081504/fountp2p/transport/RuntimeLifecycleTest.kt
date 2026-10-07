package io.github.steve02081504.fountp2p.transport

import io.github.steve02081504.fountp2p.identity
import io.github.steve02081504.fountp2p.discovery.clearDiscoveryProviders
import io.github.steve02081504.fountp2p.link.providers.LinkHandle
import io.github.steve02081504.fountp2p.link.providers.LinkProvider
import io.github.steve02081504.fountp2p.link.providers.clearLinkProviders
import io.github.steve02081504.fountp2p.link.providers.registerLinkProvider
import io.github.steve02081504.fountp2p.node.setSignalingRuntimeConfig
import io.github.steve02081504.fountp2p.node.withTempNode
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * 等价 `js/test/pure/runtime_lifecycle.test.mjs` 中针对 fount-p2p#38 的用例：
 * 通道关掉再打开后，新注册的 link provider 必须拿到 ensureListening；重启运行时后 peer health 必须恢复。
 *
 * 用假 bootstrap 覆盖注册表语义（无需真实 WS/网络）。
 */
class RuntimeLifecycleTest {
	private val self = identity(102)
	private val peer = identity(101)

	private fun localIdentityMap(): Map<String, Any?> = linkedMapOf(
		"nodeHash" to self.nodeHash,
		"nodePubKey" to self.nodePubKey,
		"secretKey" to self.secretKey,
	)

	/** 记录 ensureListening 的假 boot：reload 与启动都走同一套「补监听」逻辑。 */
	private class ListeningBootstrap : RuntimeBootstrap {
		/** provider id → 停止函数 */
		val listening = LinkedHashMap<String, () -> Unit>()
		var ensureRuntimeCalls = 0

		/**
		 * 复刻 DefaultRuntimeBootstrap.startEnabledProviderListening：
		 * 只给「已注册、已启用、尚未监听」的 provider 补 ensureListening。
		 */
		suspend fun startEnabledProviderListening() {
			for (provider in io.github.steve02081504.fountp2p.link.providers.listLinkProviders()) {
				if (!isChannelEnabled(provider.id.split(":")[0])) continue
				if (listening.containsKey(provider.id)) continue
				if (!providerNeedsListening(provider)) continue
				provider.ensureListening({ }, emptyMap())?.let { listening[provider.id] = it }
			}
		}

		private fun isChannelEnabled(name: String): Boolean {
			val channels = io.github.steve02081504.fountp2p.node.getSignalingRuntimeConfig()["channels"] as? Map<*, *>
			return channels?.get(name) != false
		}

		override fun isLive(): Boolean = true
		override fun lanTcpPort(): Int? = null
		override fun ownedLanTcp(): LinkProvider? = null
		override fun ownedBleGatt(): LinkProvider? = null

		override suspend fun ensureRuntime() {
			ensureRuntimeCalls++
			startEnabledProviderListening()
		}

		override suspend fun ensureChannelAvailable(channel: String): Boolean = true
		override suspend fun whenListening() { }
		override suspend fun whenSignalListening() { }
		override suspend fun buildLocalAdvert(scope: Any?): Map<String, Any?> = emptyMap()

		override suspend fun reloadDiscoveryRelays() {
			startEnabledProviderListening()
		}

		override suspend fun shutdown() {
			for (stop in listening.values) stop()
			listening.clear()
		}
	}

	/** 只记录监听状态的假 nostr provider（id 带 `:probe` 后缀，避免与真实 provider 的注册冲突）。 */
	private class ListeningProbeLink(override val id: String) : LinkProvider {
		override val level: Double = Double.NEGATIVE_INFINITY
		override val caps: Map<String, Any?> = mapOf("needsOfferAnswer" to false, "needsDiscoverySignal" to false, "probe" to "sync")
		var listening = false
			private set
		var listenCalls = 0
			private set

		override suspend fun isAvailable(): Boolean = true

		override fun canReach(remote: Map<String, Any?>): Boolean = true

		override suspend fun dial(options: Map<String, Any?>): LinkHandle? = null

		override suspend fun ensureListening(onInbound: (LinkHandle) -> Unit, localIdentity: Map<String, Any?>): (() -> Unit)? {
			listenCalls++
			listening = true
			return {
				listening = false
			}
		}
	}

	/** 直接返回假链路的 mock dialer（模拟一次成功的直连）。 */
	private class MockDialLinkProvider(private val link: LinkHandle) : LinkProvider {
		override val id: String = "zz-mock-dialer"
		override val level: Double = 90.0
		override val caps: Map<String, Any?> = mapOf("needsOfferAnswer" to false, "needsDiscoverySignal" to false, "probe" to "sync")
		override suspend fun isAvailable(): Boolean = true
		override fun canReach(remote: Map<String, Any?>): Boolean = true
		override suspend fun dial(options: Map<String, Any?>): LinkHandle = link
	}

	private class MockLink(override val nodeHash: String?) : LinkHandle {
		override val ready: CompletableDeferred<Unit> = CompletableDeferred(Unit)
		override val initiator: Boolean = true
		override val providerId: String = "mock"
		override val level: Double = 50.0
		override suspend fun send(envelope: Map<String, Any?>): Boolean = true
		override fun onEnvelope(callback: (Map<String, Any?>, String) -> Unit): () -> Unit = { }
		override fun onDown(callback: (String) -> Unit): () -> Unit = { }
		override fun stats(): Map<String, Any?> = mapOf("rttMs" to 5.0)
		override suspend fun close(reason: String) { }
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

	@Test
	fun `reload attaches listening to every enabled link provider not just the owned lan bt ones`() = runBlocking {
		withTempNode("fount-p2p-runtime-lifecycle-") {
			setSignalingRuntimeConfig(mapOf("channels" to mapOf("nostr" to true, "lan" to false, "bt" to false, "webrtc" to false)))
			val bootstrap = ListeningBootstrap()
			val registry = createLinkRegistry(
				LinkRegistryOptions(
					localIdentity = localIdentityMap(),
					meshKeepalive = false,
					autoRegisterDiscoveryProviders = false,
					autoRegisterLinkProviders = false,
				),
			) { bootstrap }
			val probe = ListeningProbeLink("nostr:probe")
			registerLinkProvider(probe)
			try {
				registry.ensureRuntime()
				assertEquals(1, probe.listenCalls)
				// 模拟通道关掉再打开：registry 会换上一个全新的 provider 实例（stop 函数随之失效）。
				bootstrap.listening.clear()
				registry.reloadDiscoveryRelays()
				// reload 必须把监听补到所有「已注册且已启用」的 provider 上，而不只是 ownedLanTcp/ble_gatt。
				assertEquals(2, probe.listenCalls)
				assertTrue(probe.listening)
				assertTrue(bootstrap.listening.containsKey(probe.id))
			}
			finally {
				registry.shutdown()
			}
		}
	}

	@Test
	fun `registry restarts peer health tracking after shutdown and re-init`() = runBlocking {
		withTempNode("fount-p2p-runtime-peerhealth-") {
			val link = MockLink(peer.nodeHash)
			registerLinkProvider(MockDialLinkProvider(link))
			val registry = createLinkRegistry(
				LinkRegistryOptions(
					localIdentity = localIdentityMap(),
					meshKeepalive = false,
					autoRegisterDiscoveryProviders = false,
					autoRegisterLinkProviders = false,
				),
			) { ListeningBootstrap() }
			try {
				registry.ensureRuntime()
				assertSame(link, registry.ensureLinkToNode(peer.nodeHash))
				assertEquals(true, registry.getPeerHealth(peer.nodeHash)?.connected)
				assertEquals("mock", registry.getPeerHealth(peer.nodeHash)?.source)
				registry.shutdown()
				// 重启运行时后必须恢复追踪，否则 getPeerHealth / listPeerHealth 永久为空（fount-p2p#38）。
				registry.ensureRuntime()
				assertSame(link, registry.ensureLinkToNode(peer.nodeHash))
				assertEquals(true, registry.getPeerHealth(peer.nodeHash)?.connected)
				assertEquals(1, registry.listPeerHealth().size)
			}
			finally {
				registry.shutdown()
			}
		}
	}

	@Test
	fun `network advert advertises configured Nostr listen relays`() = runBlocking {
		withTempNode("fount-p2p-runtime-advert-relays-") {
			val relayUrls = listOf("wss://configured-a.example.com", "wss://configured-b.example.com")
			setSignalingRuntimeConfig(
				mapOf("channels" to mapOf("nostr" to mapOf("relay" to relayUrls), "lan" to false, "bt" to false, "webrtc" to false)),
			)
			val bootstrap = createRuntimeBootstrap(
				RuntimeBootstrapDeps(
					localIdentity = localIdentityMap(),
					autoRegisterDiscoveryProviders = false,
					autoRegisterLinkProviders = false,
					onInboundLink = { },
					handleIncomingSignal = { },
				),
			)
			try {
				val advert = bootstrap.buildLocalAdvert("network")
				assertEquals(relayUrls, advert["listenNostrRelays"])
			}
			finally {
				bootstrap.shutdown()
				clearDiscoveryProviders()
			}
		}
	}
}
