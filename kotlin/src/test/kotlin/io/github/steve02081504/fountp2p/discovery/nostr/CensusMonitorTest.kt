package io.github.steve02081504.fountp2p.discovery.nostr

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.base64ToBytes
import io.github.steve02081504.fountp2p.core.bytesToBase64
import io.github.steve02081504.fountp2p.link.LinkScheduler
import io.github.steve02081504.fountp2p.link.LinkTimerTask
import io.github.steve02081504.fountp2p.discovery.nostr.WS_OPEN
import io.github.steve02081504.fountp2p.discovery.nostr.WS_CLOSED
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** 等价 `test/pure/census_monitor.test.mjs`（用假 WebSocket provider + 假调度器）。 */
class CensusMonitorTest {
	private class FakeTask(
		val delayMs: Long,
		val periodMs: Long?,
		val block: () -> Unit,
	) : LinkTimerTask {
		var cancelled = false
		override fun cancel() {
			cancelled = true
		}
	}

	private class FakeScheduler : LinkScheduler {
		val tasks = ArrayList<FakeTask>()
		override fun schedule(delayMs: Long, periodMs: Long?, task: () -> Unit): LinkTimerTask {
			val created = FakeTask(delayMs, periodMs, task)
			tasks.add(created)
			return created
		}

		/** 执行一次刷新防抖任务（delay = 300ms）。 */
		fun runDebounce() {
			for (task in tasks.toList()) if (!task.cancelled && task.periodMs == null && task.delayMs == 300L) task.block()
		}
	}

	private class FakeConnection : WebSocketConnection {
		override var readyState: Int = WS_OPEN
		override var onMessage: ((String) -> Unit)? = null
		override var onClose: (() -> Unit)? = null
		override var onError: (() -> Unit)? = null
		val sent = ArrayList<String>()

		override fun send(text: String) {
			sent.add(text)
		}

		override fun close() {
			readyState = WS_CLOSED
			onClose?.invoke()
		}

		override fun terminate() {
			close()
		}

		fun deliver(text: String) {
			onMessage?.invoke(text)
		}
	}

	private class FakeProvider : WebSocketProvider {
		val byUrl = LinkedHashMap<String, MutableList<FakeConnection>>()
		override suspend fun connect(url: String, target: RelayConnectTarget?): WebSocketConnection {
			val connection = FakeConnection()
			byUrl.getOrPut(url) { ArrayList() }.add(connection)
			return connection
		}

		fun openCount(): Int = byUrl.values.flatten().count { it.readyState == WS_OPEN }

		fun connectionForCensus(url: String): FakeConnection =
			byUrl[url]!!.first { it.sent.any { message -> message.contains("\"census-") } }

		fun connectionForNip66(url: String): FakeConnection =
			byUrl[url]!!.first { it.sent.any { message -> message.contains("\"nip66-") } }
	}

	private fun seed(index: Int): String = index.toString(16).padStart(64, '0')

	private fun censusEvent(seedHex: String, p: Double, subId: String): String {
		val packet = buildCensusPacketFromSeed(seedHex, p, System.currentTimeMillis())
		val content = bytesToBase64((Json.stringify(packet) ?: "null").toByteArray(Charsets.UTF_8))
		return Json.stringify(
			listOf(
				"EVENT",
				subId,
				linkedMapOf<String, Any?>(
					"id" to "0".repeat(64),
					"pubkey" to "0".repeat(64),
					"created_at" to Math.floor(System.currentTimeMillis() / 1000.0),
					"kind" to NOSTR_CENSUS_KIND.toDouble(),
					"tags" to listOf(listOf("t", "fount"), listOf("x", "census")),
					"content" to content,
					"sig" to "0".repeat(128),
				),
			),
		)!!
	}

	private fun subIdOf(connection: FakeConnection): String {
		val req = connection.sent.first { it.contains("\"REQ\"") }
		val parsed = Json.parse(req) as List<*>
		return parsed[1] as String
	}

	@Test
	fun `listens on provided relays and reports the most populous relay as display source`() {
		val scheduler = FakeScheduler()
		val provider = FakeProvider()
		val snapshots = ArrayList<Map<String, Any?>>()
		val relayA = "ws://127.0.0.1:28001"
		val relayB = "ws://127.0.0.1:28002"
		val monitor = createPopulationMonitor(
			PopulationMonitorOptions(
				onUpdate = { snapshots.add(it) },
				relays = listOf(relayA, relayB),
				discover = false,
				refreshMs = 0,
				webSocketProvider = provider,
				scheduler = scheduler,
			),
		)
		try {
			val connectionA = provider.connectionForCensus(relayA)
			val connectionB = provider.connectionForCensus(relayB)
			val subA = subIdOf(connectionA)
			val subB = subIdOf(connectionB)
			for (index in listOf(1, 2, 3)) connectionA.deliver(censusEvent(seed(index), 0.1, subA))
			connectionB.deliver(censusEvent(seed(4), 0.1, subB))
			scheduler.runDebounce()
			val fromA = snapshots.last { it["relayUrl"] == relayA && (it["estimate"] as Double) >= 30 }
			assertEquals(30.0, fromA["estimate"] as Double, 1e-9)
			assertEquals(3.0, fromA["sampleSize"] as Double, 1e-9)
			assertEquals(3.0, fromA["eventsInWindow"] as Double, 1e-9)
			assertEquals(2.0, fromA["relays"] as Double, 1e-9)
			// B 累计 4 条 → 40，超过 A 成为显示源。
			for (index in listOf(5, 6, 7)) connectionB.deliver(censusEvent(seed(index), 0.1, subB))
			scheduler.runDebounce()
			val fromB = snapshots.last { it["relayUrl"] == relayB && (it["estimate"] as Double) >= 40 }
			assertEquals(40.0, fromB["estimate"] as Double, 1e-9)
			assertEquals(4.0, fromB["sampleSize"] as Double, 1e-9)
		}
		finally {
			monitor.stop()
		}
	}

	@Test
	fun `NIP-66 discovery adds candidate relays and they feed the display`() {
		val scheduler = FakeScheduler()
		val provider = FakeProvider()
		val snapshots = ArrayList<Map<String, Any?>>()
		val discoveryRelay = "ws://127.0.0.1:28101"
		val targetRelay = "ws://127.0.0.1:28102"
		val monitor = createPopulationMonitor(
			PopulationMonitorOptions(
				onUpdate = { snapshots.add(it) },
				relays = listOf(discoveryRelay),
				nip66Bootstrap = listOf(discoveryRelay),
				refreshMs = 0,
				webSocketProvider = provider,
				scheduler = scheduler,
			),
		)
		try {
			val nip66Connection = provider.connectionForNip66(discoveryRelay)
			val nip66Sub = run {
				val req = nip66Connection.sent.first { it.contains("\"REQ\"") }
				(Json.parse(req) as List<*>)[1] as String
			}
			nip66Connection.deliver(
				Json.stringify(
					listOf(
						"EVENT",
						nip66Sub,
						linkedMapOf<String, Any?>(
							"kind" to 30166.0,
							"tags" to listOf(listOf("d", targetRelay)),
						),
					),
				)!!,
			)
			nip66Connection.deliver(Json.stringify(listOf("EOSE", nip66Sub))!!)
			assertTrue(provider.byUrl.containsKey(targetRelay))
			val targetConnection = provider.connectionForCensus(targetRelay)
			val targetSub = subIdOf(targetConnection)
			targetConnection.deliver(censusEvent(seed(9), 0.1, targetSub))
			scheduler.runDebounce()
			val discovered = snapshots.last { it["relayUrl"] == targetRelay && (it["estimate"] as Double) >= 10 }
			assertEquals(10.0, discovered["estimate"] as Double, 1e-9)
			assertEquals(2.0, discovered["relays"] as Double, 1e-9)
		}
		finally {
			monitor.stop()
		}
	}

	@Test
	fun `stop closes connections to all relays`() {
		val scheduler = FakeScheduler()
		val provider = FakeProvider()
		val relay = "ws://127.0.0.1:28201"
		val monitor = createPopulationMonitor(
			PopulationMonitorOptions(
				onUpdate = { },
				relays = listOf(relay),
				discover = false,
				refreshMs = 0,
				webSocketProvider = provider,
				scheduler = scheduler,
			),
		)
		monitor.stop()
		assertEquals(0, provider.openCount())
	}
}
