package io.github.steve02081504.fountp2p.reputation

import org.junit.Assert.assertEquals
import org.junit.Test

/** 等价 `test/pure/reputation_pick_score.test.mjs`。 */
class ReputationPickScoreTest {
	@Test
	fun `pickNodeScoreFromReputation returns global score only`() {
		val peer = "a".repeat(64)
		val rep = linkedMapOf<String, Any?>(
			"byNodeHash" to linkedMapOf<String, Any?>(
				peer to linkedMapOf<String, Any?>("score" to 0.4),
			),
		)
		assertEquals(0.4, pickNodeScoreFromReputation(rep, peer), 0.0)
		assertEquals(0.0, pickNodeScoreFromReputation(rep, "b".repeat(64)), 0.0)
	}
}
