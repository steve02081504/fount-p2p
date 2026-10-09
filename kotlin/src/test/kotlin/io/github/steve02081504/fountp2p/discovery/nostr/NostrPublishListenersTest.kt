package io.github.steve02081504.fountp2p.discovery.nostr

import io.github.steve02081504.fountp2p.core.Json
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Before
import org.junit.Test
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/**
 * 等价 `js/test/pure/nostr_publish_listeners.test.mjs`：共享 socket 上并发发布不得替换/堆积回执等待者，
 * 也不得让取消回调留在信号上（fount-p2p#44）。
 */
class NostrPublishListenersTest {
	/** 假 relay 连接：按本机 REQ 回灌 EVENT，由用例显式回 OK，便于在并发提交后再结算。 */
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

	@Test fun `queued abort survives contention on the session mutex`() = runBlocking {
		val socket = object : WebSocketConnection {
			override val readyState = WS_CONNECTING
			override var onMessage: ((String) -> Unit)? = null
			override var onClose: (() -> Unit)? = null
			override var onError: (() -> Unit)? = null
			override fun send(text: String) = Unit
			override fun close() = Unit
			override fun terminate() = Unit
		}
		setWebSocketProvider(object : WebSocketProvider {
			override suspend fun connect(url: String, target: RelayConnectTarget?) = socket
		})
		val stop = subscribeNostrKind(listOf(urls[0]), 20787, "test", "signal", { _, _ -> })
		withTimeout(2_000) { while (socket.onMessage == null) delay(5) }
		val signal = AbortSignalLike()
		val attempt = async(Dispatchers.Default) {
			runCatching { publishViaSharedRelay(urls[0], mapOf("id" to "queued-abort"), signal) }
		}
		val listeners = AbortSignalLike::class.java.getDeclaredField("listeners").apply { isAccessible = true }
		withTimeout(2_000) {
			while (synchronized(listeners.get(signal)) { (listeners.get(signal) as Set<*>).isEmpty() }) delay(5)
		}
		val mutex = Class.forName("io.github.steve02081504.fountp2p.discovery.nostr.SessionKt")
			.getDeclaredField("sessionMutex").apply { isAccessible = true }.get(null) as Mutex
		mutex.lock()
		try { signal.abort() }
		finally { mutex.unlock() }
		try {
			val result = withTimeoutOrNull(1_000) { attempt.await() }
			assertNotNull("the queued abort must settle after the mutex becomes available", result)
			assertEquals("nostr: aborted", result?.exceptionOrNull()?.message)
		}
		finally { attempt.cancel(); stop() }
	}

	@Test fun `late shared publish burst keeps a constant callback and cleans abort and OK waiters`() = runBlocking {
		val stop = subscribeNostrKind(listOf(urls[0]), 20787, "test", "signal", { _, _ -> })
		try {
			withTimeout(2_000) { while (sockets[urls[0]]?.requests?.isEmpty() != false) delay(5) }
			val socket = sockets[urls[0]]!!
			val baseline = socket.onMessage
			val signal = AbortSignalLike()
			val okSignal = AbortSignalLike()
			val attempts = (0 until 40).map { index -> async(Dispatchers.Default) {
				runCatching { publishViaSharedRelay(urls[0], mapOf("id" to "burst-$index"), if (index % 2 == 1) signal else okSignal) }
			} }
			withTimeout(2_000) { while (socket.events.size < 40) delay(5) }
			assertSame("concurrent publishes must not replace the socket callback", baseline, socket.onMessage)
			signal.abort()
			socket.acceptAll()
			val results = withTimeout(2_000) { attempts.awaitAll() }
			assertEquals(20, results.count { it.getOrNull() == true })
			assertEquals(20, results.count { it.isFailure })
			assertEquals(40, socket.events.size)
			assertEquals(40, socket.events.map { it["id"] }.toSet().size)
			assertSame(baseline, socket.onMessage)
			val listeners = AbortSignalLike::class.java.getDeclaredField("listeners").apply { isAccessible = true }
			assertEquals("successful publishes release abort callbacks", 0, (listeners.get(okSignal) as Set<*>).size)
		}
		finally { stop() }
	}
}
