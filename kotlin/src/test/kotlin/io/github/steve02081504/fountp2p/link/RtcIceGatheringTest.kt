package io.github.steve02081504.fountp2p.link

import io.github.steve02081504.fountp2p.link.providers.IceGatheringOptions
import io.github.steve02081504.fountp2p.link.providers.collectIceGathering
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 等价 `js/test/pure/rtc_ice_gathering.test.mjs`：
 * 服务端 polyfill 不把 `iceGatheringState` 推成 `complete` 时，等待必须有终点（fount-p2p#37 次要观察）。
 */
class RtcIceGatheringTest {
	/**
	 * @param states iceGatheringState 序列（最后一个值持续复用）
	 * @param candidates 候选数序列（最后一个值持续复用）
	 * @return 观测配置与推进函数
	 */
	private fun probe(states: List<String> = listOf("gathering"), candidates: List<Int> = listOf(0)): Pair<IceGatheringOptions, () -> Unit> {
		var stateIndex = 0
		var candidateIndex = 0
		val options = IceGatheringOptions(
			iceGatheringState = { states[minOf(stateIndex, states.size - 1)] },
			handshakeTimeoutMs = 30_000,
			candidateCount = { candidates[minOf(candidateIndex, candidates.size - 1)] },
		)
		return options to {
			stateIndex++
			candidateIndex++
		}
	}

	@Test
	fun `collectIceGathering returns complete as soon as the state is complete`() = runBlocking {
		val (options, _) = probe(states = listOf("complete"))
		assertEquals("complete", collectIceGathering(options))
	}

	@Test
	fun `collectIceGathering treats a quiet candidate stream as gathered even when the state never turns complete`() = runBlocking {
		// 复现 fount-p2p#37 次要观察：polyfill 派发了候选，但 iceGatheringState 仍停在 'gathering'。
		val (options, advance) = probe(candidates = listOf(0, 1))
		val job = launch {
			while (true) {
				delay(60)
				advance()
			}
		}
		try {
			val startedAt = System.currentTimeMillis()
			assertEquals("stable", withTimeout(10_000) { collectIceGathering(options) })
			assertTrue(System.currentTimeMillis() - startedAt < 5_000)
		}
		finally {
			job.cancel()
		}
	}

	@Test
	fun `collectIceGathering gives up on a stalled gathering instead of hanging forever`() = runBlocking {
		val (options, _) = probe()
		val stalls = ArrayList<Long>()
		val startedAt = System.currentTimeMillis()
		val result = collectIceGathering(
			IceGatheringOptions(
				iceGatheringState = options.iceGatheringState,
				handshakeTimeoutMs = 30_000,
				candidateCount = options.candidateCount,
				onStall = { stalls.add(it) },
			),
		)
		assertEquals("stalled", result)
		assertEquals(1, stalls.size)
		// 必须在 handshakeTimeoutMs 之前就放行，否则「所有 relay 都超时」时必然撞 10s 硬失败。
		assertTrue(System.currentTimeMillis() - startedAt < 10_000)
	}

	@Test
	fun `collectIceGathering stops as soon as gathering reports complete after candidates`() = runBlocking {
		val (options, advance) = probe(states = listOf("gathering", "complete"), candidates = listOf(0, 2))
		val job = launch {
			while (true) {
				delay(60)
				advance()
			}
		}
		try {
			assertEquals("complete", withTimeout(10_000) { collectIceGathering(options) })
		}
		finally {
			job.cancel()
		}
	}

	@Test
	fun `collectIceGathering still fails when a timeout is shorter than the stall window`() = runBlocking {
		val (options, _) = probe()
		var message: String? = null
		try {
			collectIceGathering(
				IceGatheringOptions(
					iceGatheringState = options.iceGatheringState,
					handshakeTimeoutMs = 200,
					candidateCount = options.candidateCount,
				),
			)
		}
		catch (error: IllegalStateException) {
			message = error.message
		}
		assertTrue(message?.contains("ice gathering incomplete after 200ms") == true)
	}
}
