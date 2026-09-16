package io.github.steve02081504.fountp2p.node

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 等价 `test/integration/reputation_rate.test.mjs`。
 */
class ReputationRateTest {
	private val peer = "d".repeat(64)

	@Test
	fun `recordMessageRateViolation awaits persistence before returning`() = runBlocking {
		withTempNode("fount-rep-rate-") {
			recordMessageRateViolation(peer, 1.0)
			@Suppress("UNCHECKED_CAST")
			val byNodeHash = loadReputation()["byNodeHash"] as Map<String, Any?>
			val row = byNodeHash[peer] as? Map<*, *>
			val score = (row?.get("score") as? Number)?.toDouble() ?: 0.0
			assertEquals(true, score < -0.01)
		}
	}
}
