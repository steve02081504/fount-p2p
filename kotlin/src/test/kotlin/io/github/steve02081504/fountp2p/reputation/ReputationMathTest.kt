package io.github.steve02081504.fountp2p.reputation

import org.junit.Assert.assertEquals
import org.junit.Test

/** 等价 `test/pure/reputation_math.test.mjs`。 */
class ReputationMathTest {
	@Test
	fun `computeRepMaxEff only uses positive trust anchors`() {
		val withPositive = computeRepMaxEff(
			linkedMapOf<String, Any?>(
				"byNodeHash" to linkedMapOf<String, Any?>(
					"a" to linkedMapOf<String, Any?>("score" to -0.8),
					"b" to linkedMapOf<String, Any?>("score" to 0.0),
					"c" to linkedMapOf<String, Any?>("score" to 0.62),
				),
			),
		)
		assertEquals(0.62, withPositive, 0.0)

		val allNonPositive = computeRepMaxEff(
			linkedMapOf<String, Any?>(
				"byNodeHash" to linkedMapOf<String, Any?>(
					"a" to linkedMapOf<String, Any?>("score" to -0.8),
					"b" to linkedMapOf<String, Any?>("score" to 0.0),
				),
			),
		)
		assertEquals(REP_MAX_EFF_EPS, allNonPositive, 0.0)
	}

	@Test
	fun `subjectiveSlashPenalty ignores negative sender reputation`() {
		val unverifiedBadSender = subjectiveSlashPenalty(0.5, -0.9, 1.0, false)
		assertEquals(0.0, unverifiedBadSender, 0.0)

		val unverifiedGoodSender = subjectiveSlashPenalty(0.5, 0.9, 1.0, false)
		assertEquals(true, unverifiedGoodSender > 0)

		val verifiedPenalty = subjectiveSlashPenalty(0.5, -0.9, 1.0, true)
		assertEquals(true, verifiedPenalty > 0)
	}
}
