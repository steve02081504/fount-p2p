package io.github.steve02081504.fountp2p.discovery.nostr

import io.github.steve02081504.fountp2p.core.Json
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.Assert.assertTrue

/** 测试配置中继发布的成功、失败与超时都会更新中继健康度。 */
class NostrPublishOutcomeTest {
	private data class Behavior(val accepted: Boolean?, val delayMs: Long = 0L)

	private class OutcomeConnection(private val behavior: Behavior) : WebSocketConnection {
		override val readyState: Int = WS_OPEN
		override var onMessage: ((String) -> Unit)? = null
		override var onClose: (() -> Unit)? = null
		override var onError: (() -> Unit)? = null
		private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

		override fun send(text: String) {
			val parsed = runCatching { Json.parse(text) as? List<*> }.getOrNull() ?: return
			if (parsed.getOrNull(0) != "EVENT") return
			val event = parsed.getOrNull(1) as? Map<*, *> ?: return
			val accepted = behavior.accepted ?: return
			scope.launch {
				delay(behavior.delayMs)
				onMessage?.invoke(Json.stringify(listOf("OK", event["id"], accepted, "")) ?: "")
			}
		}

		override fun close() { scope.cancel() }
		override fun terminate() { scope.cancel() }
	}

	private class OutcomeProvider(private val behaviors: Map<String, Behavior>) : WebSocketProvider {
		override suspend fun connect(url: String, target: RelayConnectTarget?): WebSocketConnection =
			OutcomeConnection(behaviors[url] ?: error("unexpected relay $url"))
	}

	private var releaseConfiguredRelays: (() -> Unit)? = null

	@Before
	fun setUp() = runBlocking {
		clearSharedRelaySessionsForTests()
		setRelayStorageIOForTests(object : RelayStorageIO {
			override fun read(): Any? = null
			override fun write(data: Any?) = Unit
		})
		clearRelayPoolForTests()
		setQueuedPublishDeadlineMsForTests(1_000)
	}

	@After
	fun tearDown() = runBlocking {
		setWebSocketProvider(null)
		setQueuedPublishDeadlineMsForTests(null)
		releaseConfiguredRelays?.invoke()
		releaseConfiguredRelays = null
		clearSharedRelaySessionsForTests()
	}

	private fun relay(index: Int) = "ws://127.0.0.1:${20_000 + index}"
	private val event = mapOf("id" to "a".repeat(64))
	private fun trust(vararg urls: String) {
		releaseConfiguredRelays = registerProviderTrustedRelayUrls(urls.toList())
	}

	@Test
	fun `configured fast rejection and slower acceptance both update pool health`() = runBlocking {
		val rejected = relay(1)
		val accepted = relay(2)
		trust(rejected, accepted)
		setWebSocketProvider(OutcomeProvider(mapOf(rejected to Behavior(false), accepted to Behavior(true, 80))))

		publishEvent(listOf(rejected, accepted), event)

		val pool = getPoolByUrl()
		assertTrue("configured rejection is recorded", (pool[rejected]?.lastPublishFailure ?: 0L) > 0)
		assertTrue("slower configured acceptance is recorded", (pool[accepted]?.lastPublishSuccess ?: 0L) > 0)
	}

	@Test
	fun `configured publish timeout demotes its relay`() = runBlocking {
		val url = relay(3)
		trust(url)
		setWebSocketProvider(OutcomeProvider(mapOf(url to Behavior(null))))

		val failed = runCatching { withTimeout(5_000) { publishEvent(listOf(url), event) } }.isFailure

		assertTrue("publish without an OK response fails", failed)
		assertTrue("configured timeout is recorded as a publish failure", (getPoolByUrl()[url]?.lastPublishFailure ?: 0L) > 0)
	}

	@Test
	fun `late configured rejection is recorded after another relay accepts`() = runBlocking {
		val accepted = relay(4)
		val rejected = relay(5)
		trust(accepted, rejected)
		setWebSocketProvider(OutcomeProvider(mapOf(accepted to Behavior(true), rejected to Behavior(false, 100))))

		publishEvent(listOf(accepted, rejected), event)
		// 背景尝试自行结算：窗口留出余量，别让断言跑在失败记录之前。
		withTimeout(5_000) {
			while ((getPoolByUrl()[rejected]?.lastPublishFailure ?: 0L) == 0L) delay(10)
		}

		assertTrue("first relay's success is recorded", (getPoolByUrl()[accepted]?.lastPublishSuccess ?: 0L) > 0)
		assertTrue("background rejection is recorded after early return", (getPoolByUrl()[rejected]?.lastPublishFailure ?: 0L) > 0)
	}
}
