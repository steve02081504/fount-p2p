package io.github.steve02081504.fountp2p.discovery.nostr

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.discovery.clearDiscoveryProviders
import io.github.steve02081504.fountp2p.discovery.registerDiscoveryProvider
import io.github.steve02081504.fountp2p.identity
import io.github.steve02081504.fountp2p.link.providers.clearLinkProviders
import io.github.steve02081504.fountp2p.link.providers.nostr.createNostrLinkProvider
import io.github.steve02081504.fountp2p.link.providers.registerLinkProvider
import io.github.steve02081504.fountp2p.node.withTempNode
import io.github.steve02081504.fountp2p.transport.LinkRegistryOptions
import io.github.steve02081504.fountp2p.transport.createLinkRegistry
import io.github.steve02081504.fountp2p.transport.setLinkDialDeadlineMsForTests
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * 等价 `js/test/pure/nostr_publish_ok.test.mjs` 中针对 fount-p2p#37 的三条用例：
 * relay 能解析但永远完不成 WS 握手时，publish / 建链都必须有界结算。
 *
 * JS 侧用「接受 TCP 连接但永不回 HTTP 响应」的假 relay 复现；Kotlin 侧 WS 由宿主注入，
 * 故用「connect 永不返回」的假 [WebSocketProvider] 等价复现（连接超时 2s 后进入退避重连循环）。
 */
class NostrPublishDeadlineTest {
	/** 永远建不起来的 WS 连接。 */
	private class HangingWebSocketConnection : WebSocketConnection {
		override val readyState: Int = WS_CONNECTING
		override var onMessage: ((String) -> Unit)? = null
		override var onClose: (() -> Unit)? = null
		override var onError: (() -> Unit)? = null
		override fun send(text: String) = Unit
		override fun close() = Unit
		override fun terminate() = Unit
	}

	/** 立即接受 EVENT 的 WS 连接（回 OK true）。 */
	private class AcceptingWebSocketConnection : WebSocketConnection {
		override val readyState: Int = WS_OPEN
		override var onMessage: ((String) -> Unit)? = null
		override var onClose: (() -> Unit)? = null
		override var onError: (() -> Unit)? = null
		val sentTexts: MutableList<String> = java.util.concurrent.CopyOnWriteArrayList()

		override fun send(text: String) {
			sentTexts.add(text)
			val parsed = runCatching { Json.parse(text) as? List<*> }.getOrNull() ?: return
			if (parsed.getOrNull(0) != "EVENT") return
			val event = parsed.getOrNull(1) as? Map<*, *> ?: return
			onMessage?.invoke(Json.stringify(listOf("OK", event["id"], true, "")) ?: "")
		}

		override fun close() = Unit
		override fun terminate() = Unit
	}

	/** 指定 URL 行为：hang 表示永远连不上，accept 表示连上并接受 EVENT。 */
	private class RoutingWebSocketProvider(
		private val behaviors: Map<String, String>,
		val accepting: MutableMap<String, AcceptingWebSocketConnection> = LinkedHashMap(),
	) : WebSocketProvider {
		override suspend fun connect(url: String, target: RelayConnectTarget?): WebSocketConnection {
			if (behaviors[url] == "hang") {
				// 永不返回：由 connectRelay 的连接超时兜底。
				CompletableDeferred<Unit>().await()
			}
			val connection = AcceptingWebSocketConnection()
			accepting[url] = connection
			return connection
		}
	}

	@Before
	fun setUp() = runBlocking {
		// 每个用例从干净的会话表开始：上一个用例的退避重连循环会占住 sessionMutex。
		clearSharedRelaySessionsForTests()
		clearDiscoveryProviders()
		clearLinkProviders()
	}

	@After
	fun tearDown() = runBlocking {
		setWebSocketProvider(null)
		setQueuedPublishDeadlineMsForTests(null)
		setLinkDialDeadlineMsForTests(null)
		clearSharedRelaySessionsForTests()
		clearDiscoveryProviders()
		clearLinkProviders()
	}

	@Test
	fun `publish settles when a relay resolves but never completes the WS connect`() = runBlocking {
		val local = identity(80)
		val hangUrl = "ws://127.0.0.1:1"
		setWebSocketProvider(RoutingWebSocketProvider(mapOf(hangUrl to "hang")))
		setQueuedPublishDeadlineMsForTests(300)
		val provider = createNostrDiscoveryProvider(mapOf("relayUrls" to listOf(hangUrl)))
		registerDiscoveryProvider(provider)
		try {
			val startedAt = System.currentTimeMillis()
			val threw = runCatching {
				withTimeout(5_000) { provider.sendNodeSignal(local.nodeHash, byteArrayOf(1, 2, 3)) }
			}.isFailure
			val elapsedMs = System.currentTimeMillis() - startedAt
			assertEquals(true, threw)
			assertTrue("publish settled after ${elapsedMs}ms", elapsedMs < 5_000)
		}
		finally {
			provider.dispose()
		}
	}

	@Test
	fun `publish resolves on the first accepting relay while a pooled relay stays unreachable`() = runBlocking {
		val local = identity(86)
		val peer = identity(87)
		val healthyUrl = "ws://127.0.0.1:2"
		val hangUrl = "ws://127.0.0.1:3"
		val ws = RoutingWebSocketProvider(mapOf(healthyUrl to "accept", hangUrl to "hang"))
		setWebSocketProvider(ws)
		// 入队上限给足余量：连不上的 relay 会占住 sessionMutex 直到它自己的连接超时，
		// 健康 relay 的尝试可能排在它后面。
		setQueuedPublishDeadlineMsForTests(4_000)
		val provider = createNostrDiscoveryProvider(mapOf("relayUrls" to listOf(healthyUrl, hangUrl)))
		registerDiscoveryProvider(provider)
		try {
			val startedAt = System.currentTimeMillis()
			withTimeout(6_000) { provider.sendNodeSignal(peer.nodeHash, byteArrayOf(7, 7, 7)) }
			val elapsedMs = System.currentTimeMillis() - startedAt
			assertEquals("frames sent to the healthy relay: ${ws.accepting[healthyUrl]?.sentTexts?.map { it.take(90) }}", 1, ws.accepting[healthyUrl]?.sentTexts?.size)
			assertTrue("publish waited ${elapsedMs}ms for an unreachable pooled relay", elapsedMs < 6_000)
		}
		finally {
			provider.dispose()
		}
	}

	@Test
	fun `ensureLinkToNode settles and does not poison later dials when a provider stays stuck`() = runBlocking {
		val alice = identity(88)
		val bob = identity(89)
		val hangUrl = "ws://127.0.0.1:4"
		withTempNode("fount-p2p-issue37-") {
			setWebSocketProvider(RoutingWebSocketProvider(mapOf(hangUrl to "hang")))
			// 入队 publish 保持默认上限（远大于 dial 上限），确保是 registry 自己的整体上限在兜底。
			setLinkDialDeadlineMsForTests(1_500)
			clearLinkProviders()
			clearDiscoveryProviders()
			// 显式 relayUrls 让该 URL 进入受信集，relay 才会真正尝试连接（而不是被公网校验直接拒掉）。
			val discovery = createNostrDiscoveryProvider(mapOf("relayUrls" to listOf(hangUrl), "localNodeHash" to alice.nodeHash))
			registerDiscoveryProvider(discovery)
			registerLinkProvider(createNostrLinkProvider(mapOf("getRelayUrls" to { listOf(hangUrl) })))
			val registry = createLinkRegistry(
				LinkRegistryOptions(
					localIdentity = linkedMapOf(
						"nodeHash" to alice.nodeHash,
						"nodePubKey" to alice.nodePubKey,
						"secretKey" to alice.secretKey,
					),
					meshKeepalive = false,
					autoRegisterDiscoveryProviders = false,
					autoRegisterLinkProviders = false,
				),
			)
			try {
				registry.ensureRuntime()
				val firstStartedAt = System.currentTimeMillis()
				assertEquals(null, registry.ensureLinkToNode(bob.nodeHash))
				val firstMs = System.currentTimeMillis() - firstStartedAt
				assertTrue("first dial settled after ${firstMs}ms", firstMs < 4_000)
				val secondStartedAt = System.currentTimeMillis()
				assertEquals(null, registry.ensureLinkToNode(bob.nodeHash))
				val secondMs = System.currentTimeMillis() - secondStartedAt
				assertTrue("second dial settled after ${secondMs}ms instead of reusing a stuck dial", secondMs < 4_000)
			}
			finally {
				registry.shutdown()
			}
		}
	}
}
