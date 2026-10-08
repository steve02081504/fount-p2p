package io.github.steve02081504.fountp2p.discovery.nostr

import io.github.steve02081504.fountp2p.core.Json
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/**
 * 等价 `js/test/pure/nostr_directed_reachability.test.mjs`：显式 relay 配置只描述本机中继集，
 * 对端订阅的是它自己的监听集，故定向信令要并上对端广告的监听集，否则两套无交集时事件发出去也没人听（fount-p2p#43）。
 */
class NostrDirectedReachabilityTest {
	/** 假 relay 连接：按本机 REQ 把 EVENT 回灌给订阅者（等价 JS 的 broadcast 假 relay）。 */
	private class RelayConnection : WebSocketConnection {
		override val readyState = WS_OPEN
		override var onMessage: ((String) -> Unit)? = null
		override var onClose: (() -> Unit)? = null
		override var onError: (() -> Unit)? = null
		val requests = CopyOnWriteArrayList<List<*>>()
		val events = CopyOnWriteArrayList<Map<String, Any?>>()
		override fun send(text: String) {
			val frame = Json.parse(text) as List<*>
			if (frame[0] == "REQ") requests.add(frame)
			if (frame[0] == "EVENT") {
				@Suppress("UNCHECKED_CAST")
				val event = frame[1] as Map<String, Any?>
				events.add(event)
				for (request in requests) {
					val filter = request[2] as Map<*, *>
					val tag = (filter["#t"] as List<*>)[0]
					if ((event["tags"] as? List<*>)?.any { (it as List<*>).take(2) == listOf("t", tag) } == true)
						onMessage?.invoke(Json.stringify(listOf("EVENT", request[1], event))!!)
				}
			}
		}
		/** 接受本连接上已收到的全部事件（回 OK true）。 */
		fun acceptAll() {
			for (event in events) onMessage?.invoke(Json.stringify(listOf("OK", event["id"], true, ""))!!)
		}
		override fun close() = Unit
		override fun terminate() = Unit
	}

	private val sockets = ConcurrentHashMap<String, RelayConnection>()
	private var releaseTrust: (() -> Unit)? = null
	private val urls = listOf("ws://127.0.0.1:29001", "ws://127.0.0.1:29002")

	@Before fun setUp() {
		clearSharedRelaySessionsForTests()
		setRelayStorageIOForTests(object : RelayStorageIO {
			override fun read(): Any? = null
			override fun write(data: Any?) = Unit
		})
		clearRelayPoolForTests()
		releaseTrust = registerProviderTrustedRelayUrls(urls)
		setWebSocketProvider(object : WebSocketProvider {
			override suspend fun connect(url: String, target: RelayConnectTarget?): WebSocketConnection =
				RelayConnection().also { sockets[url] = it }
		})
	}

	@After fun tearDown() {
		clearSharedRelaySessionsForTests()
		setWebSocketProvider(null)
		releaseTrust?.invoke()
	}

	@Test fun `explicit local sets deliver directed signals to disjoint peer listeners`() = runBlocking {
		val hashes = listOf("ab".repeat(32), "cd".repeat(32))
		val providers = listOf(createNostrDiscoveryProvider(mapOf("relayUrls" to listOf(urls[0]))),
			createNostrDiscoveryProvider(mapOf("getRelayUrls" to { listOf(urls[1]) })))
		val received = listOf(CompletableDeferred<ByteArray>(), CompletableDeferred<ByteArray>())
		try {
			for (index in 0..1) {
				setPeerRoute(hashes[index], mapOf("listenRelays" to listOf(urls[index])))
				providers[index].listenNodeSignals(hashes[index]) { bytes -> received[index].complete(bytes) }
			}
			withTimeout(2_000) { while (sockets.size != 2 || sockets.values.any { it.requests.isEmpty() }) delay(5) }
			val sends = listOf(async { providers[0].sendNodeSignal(hashes[1], byteArrayOf(1)) }, async { providers[1].sendNodeSignal(hashes[0], byteArrayOf(2)) })
			withTimeout(2_000) {
				while (sockets.values.sumOf { it.events.size } < 4) delay(5)
				for (socket in sockets.values) socket.acceptAll()
				sends.awaitAll()
				assertEquals(listOf(2.toByte()), received[0].await().toList())
				assertEquals(listOf(1.toByte()), received[1].await().toList())
			}
		}
		finally { providers.forEach { it.dispose() } }
	}

	@Test fun `a routed signal with no reachable relay rejects instead of reporting success`() = runBlocking {
		clearRelayPoolForTests()
		val provider = createNostrDiscoveryProvider()
		try {
			val result = runCatching { provider.sendNodeSignal("ef".repeat(32), byteArrayOf(3)) }
			assertTrue(result.exceptionOrNull()?.message?.contains("no relay accepted directed signal") == true)
		}
		finally { provider.dispose() }
	}
}
