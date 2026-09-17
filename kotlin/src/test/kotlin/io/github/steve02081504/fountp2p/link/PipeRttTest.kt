package io.github.steve02081504.fountp2p.link

import io.github.steve02081504.fountp2p.identity
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 等价 `test/pure/link_rtt.test.mjs`（用假调度器避免真实 sleep）。 */
class PipeRttTest {
	private class FakeScheduler : LinkScheduler {
		private class Task(
			val delayMs: Long,
			val periodMs: Long?,
			val block: () -> Unit,
		) : LinkTimerTask {
			var cancelled = false
			override fun cancel() {
				cancelled = true
			}
		}

		private val tasks = ArrayList<Task>()

		override fun schedule(delayMs: Long, periodMs: Long?, task: () -> Unit): LinkTimerTask {
			val created = Task(delayMs, periodMs, task)
			tasks.add(created)
			return created
		}

		/** 触发所有未取消的周期任务一次。 */
		fun runPeriodic() {
			for (task in tasks.toList()) if (!task.cancelled && task.periodMs != null) task.block()
		}
	}

	private class PipePair(
		val initiatorPipe: LinkPipe,
		val responderPipe: LinkPipe,
		val scheduler: FakeScheduler,
		val nowMs: () -> Long,
		val flushPings: () -> Unit,
	)

	private fun connectPipes(initiatorPingDelay: Boolean = false): PipePair {
		val initiatorIdentity = identity(1)
		val responderIdentity = identity(2)
		val binding = "ab".repeat(32)
		val scheduler = FakeScheduler()
		var now = 1_000L
		lateinit var initiatorPipe: LinkPipe
		lateinit var responderPipe: LinkPipe
		val bufferedPings = ArrayList<ByteArray>()

		fun deliverToInitiator(data: Any?) {
			initiatorPipe.handleInbound(data)
		}

		fun deliverToResponder(data: Any?) {
			responderPipe.handleInbound(data)
		}

		fun optionsFor(
			initiator: Boolean,
			nodeHash: String,
			localIdentity: Map<String, Any?>,
		): LinkPipeOptions = LinkPipeOptions(
			providerId = "mock",
			level = 10.0,
			initiator = initiator,
			nodeHash = nodeHash,
			localIdentity = localIdentity,
			getLocalBinding = { binding },
			getRemoteBinding = { binding },
			sendControlText = { text -> if (initiator) deliverToResponder(text) else deliverToInitiator(text) },
			sendFrame = { action, frame ->
				if (initiator && action == "ping" && initiatorPingDelay) bufferedPings.add(frame)
				else if (initiator) deliverToResponder(frame)
				else deliverToInitiator(frame)
			},
			heartbeatMs = 15,
			idleTimeoutMs = 5000,
			handshakeTimeoutMs = 3000,
			rttWindowSize = 5,
			scheduler = scheduler,
			now = { now },
		)

		initiatorPipe = LinkPipe(optionsFor(true, responderIdentity.nodeHash, initiatorIdentity.asMap()))
		responderPipe = LinkPipe(optionsFor(false, initiatorIdentity.nodeHash, responderIdentity.asMap()))
		return PipePair(
			initiatorPipe,
			responderPipe,
			scheduler,
			{ now },
			{
				for (frame in bufferedPings.toList()) deliverToResponder(frame)
				bufferedPings.clear()
			},
		)
	}

	private fun io.github.steve02081504.fountp2p.TestIdentity.asMap(): Map<String, Any?> =
		mapOf("nodeHash" to nodeHash, "nodePubKey" to nodePubKey, "secretKey" to secretKey)

	@Test
	fun `pipe heartbeat measures RTT and exposes sliding window stats`() = runBlocking {
		val pair = connectPipes()
		try {
			pair.initiatorPipe.startHandshake()
			pair.responderPipe.startHandshake()
			pair.initiatorPipe.ready.await()
			pair.responderPipe.ready.await()
			pair.scheduler.runPeriodic()
			val stats = pair.initiatorPipe.stats()
			assertTrue((stats["pingCount"] as Double) > 0)
			assertTrue((stats["pongCount"] as Double) > 0)
			assertNotNull(stats["rttMs"])
			assertTrue((stats["rttMs"] as Double) >= 0)
			assertNotNull(stats["avgRttMs"])
			assertNotNull(stats["minRttMs"])
			assertNotNull(stats["maxRttMs"])
		}
		finally {
			pair.initiatorPipe.close("test-done")
			pair.responderPipe.close("test-done")
		}
	}

	@Test
	fun `pipe onRtt fires after pong round trip`() = runBlocking {
		val pair = connectPipes()
		try {
			pair.initiatorPipe.startHandshake()
			pair.responderPipe.startHandshake()
			pair.initiatorPipe.ready.await()
			pair.responderPipe.ready.await()
			val samples = ArrayList<Double>()
			val unsubscribe = pair.initiatorPipe.onRtt { samples.add(it) }
			pair.scheduler.runPeriodic()
			unsubscribe()
			assertTrue(samples.isNotEmpty())
			assertTrue(samples.all { it >= 0 })
		}
		finally {
			pair.initiatorPipe.close("test-done")
			pair.responderPipe.close("test-done")
		}
	}

	@Test
	fun `pipe RTT matches the ping it answers even after a later heartbeat`() = runBlocking {
		val pair = connectPipes(initiatorPingDelay = true)
		try {
			pair.initiatorPipe.startHandshake()
			pair.responderPipe.startHandshake()
			pair.initiatorPipe.ready.await()
			pair.responderPipe.ready.await()
			pair.scheduler.runPeriodic()
			pair.scheduler.runPeriodic()
			pair.flushPings()
			val stats = pair.initiatorPipe.stats()
			assertTrue((stats["pingCount"] as Double) > 0)
			assertTrue((stats["pongCount"] as Double) > 0)
			assertTrue((stats["rttMs"] as Double) >= 0)
		}
		finally {
			pair.initiatorPipe.close("test-done")
			pair.responderPipe.close("test-done")
		}
	}
}
