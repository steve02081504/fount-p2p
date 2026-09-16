package io.github.steve02081504.fountp2p.governance

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** 等价 `test/pure/join_pow.test.mjs`。 */
class JoinPowTest {
	private val group = "g-test"
	private val anchor = "a".repeat(64)
	private val joiner = "b".repeat(64)

	@Test
	fun `joinPowHashMeetsDifficulty checks leading zero bits`() {
		assertEquals(true, joinPowHashMeetsDifficulty("0000ffff", 16.0))
		assertEquals(false, joinPowHashMeetsDifficulty("0001ffff", 16.0))
		assertEquals(28, countAchievedLeadingZeroBits("0000000f"))
	}

	@Test
	fun `verifyJoinPow accepts valid solution and returns achievedBits`() {
		val epochMs = JOIN_POW_DEFAULT_EPOCH_MS
		val epoch = Math.floor(System.currentTimeMillis().toDouble() / epochMs)
		val solution = solveJoinPow(
			linkedMapOf(
				"groupId" to group,
				"anchorRef" to anchor,
				"joinerNodeHash" to joiner,
				"epoch" to epoch,
			),
			8.0,
		) ?: throw AssertionError("solveJoinPow failed")

		val result = verifyJoinPow(
			solution,
			linkedMapOf(
				"groupId" to group,
				"senderNodeHash" to joiner,
				"knownAnchors" to listOf(anchor),
				"now" to epoch * epochMs,
				"difficultyBits" to 8.0,
				"epochMs" to epochMs,
			),
		)
		assertEquals(true, result.ok)
		assertEquals(true, result.achievedBits >= 8)
	}

	@Test
	fun `verifyJoinPow rejects wrong anchor and sender binding`() {
		val epochMs = JOIN_POW_DEFAULT_EPOCH_MS
		val epoch = Math.floor(System.currentTimeMillis().toDouble() / epochMs)
		val solution = solveJoinPow(
			linkedMapOf(
				"groupId" to group,
				"anchorRef" to anchor,
				"joinerNodeHash" to joiner,
				"epoch" to epoch,
			),
			6.0,
		) ?: throw AssertionError("solveJoinPow failed")

		assertEquals(
			false,
			verifyJoinPow(
				solution,
				linkedMapOf(
					"groupId" to group,
					"senderNodeHash" to joiner,
					"knownAnchors" to listOf("c".repeat(64)),
					"difficultyBits" to 6.0,
					"epochMs" to epochMs,
					"now" to epoch * epochMs,
				),
			).ok,
		)
		assertEquals(
			false,
			verifyJoinPow(
				solution,
				linkedMapOf(
					"groupId" to group,
					"senderNodeHash" to "d".repeat(64),
					"knownAnchors" to listOf(anchor),
					"difficultyBits" to 6.0,
					"epochMs" to epochMs,
					"now" to epoch * epochMs,
				),
			).ok,
		)
	}

	@Test
	fun `powVoluntaryBonus log-decays toward cap`() {
		val floor = 18
		val cap = DEFAULT_ADMISSION_TUNABLES["powVoluntaryBonusCap"] as Double
		val b0 = powVoluntaryBonus(floor, floor, DEFAULT_ADMISSION_TUNABLES)
		val b1 = powVoluntaryBonus(floor + 1, floor, DEFAULT_ADMISSION_TUNABLES)
		val b8 = powVoluntaryBonus(floor + 8, floor, DEFAULT_ADMISSION_TUNABLES)
		assertEquals(0.0, b0, 1e-12)
		assertTrue(b1 > 0 && b1 < cap)
		assertTrue(b8 > b1 && b8 <= cap)
	}
}
