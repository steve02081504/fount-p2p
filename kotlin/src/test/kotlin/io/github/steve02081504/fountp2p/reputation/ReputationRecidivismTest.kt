package io.github.steve02081504.fountp2p.reputation

import org.junit.Assert.assertEquals
import org.junit.Test

/** 等价 `test/pure/reputation_recidivism.test.mjs`。 */
class ReputationRecidivismTest {
	private val tunables = defaultReputationTunables()
	private val PEER = "a".repeat(64)

	@Test
	fun `computeRecidivismMultiplier escalates with streak`() {
		val step = tunables["recidivismMultiplierStep"] as Double
		assertEquals(1 + step, computeRecidivismMultiplier(1.0, tunables), 0.0)
		assertEquals(minOf(tunables["recidivismMax"] as Double, 1 + step * 4), computeRecidivismMultiplier(4.0, tunables), 0.0)
		assertEquals(tunables["recidivismMax"] as Double, computeRecidivismMultiplier(100.0, tunables), 0.0)
	}

	@Test
	fun `repeat penalties escalate without time window reset`() {
		val data = newRepFile()
		val t0 = 1_000_000.0
		val delta = 0.1
		adjustNodeReputation(data, PEER, -delta, t0, tunables)
		val first = rowScore(data, PEER)
		val secondMult = computeRecidivismMultiplier(2.0, tunables)
		adjustNodeReputation(data, PEER, -delta, t0 + 86_400_000.0, tunables)
		val second = rowScore(data, PEER)
		assertEquals(-delta * computeRecidivismMultiplier(1.0, tunables), first, 0.0)
		assertEquals(first - delta * secondMult, second, 0.0)
		assertEquals(2.0, repRow(data, PEER)["offenseStreak"] as Double, 0.0)
	}

	@Test
	fun `positive contribution redeems offense streak`() {
		val data = newRepFile()
		adjustNodeReputation(data, PEER, -0.2, 1000.0, tunables)
		assertEquals(1.0, repRow(data, PEER)["offenseStreak"] as Double, 0.0)
		val bumpsNeeded = Math.ceil((tunables["redemptionCreditPerStreakLevel"] as Double) / (tunables["relayRepBump"] as Double)).toInt()
		for (i in 0 until bumpsNeeded)
			bumpReputationOnRelayPure(data, PEER, "k$i", 2000.0 + i, tunables)
		assertEquals(0.0, (repRow(data, PEER)["offenseStreak"] as? Double) ?: 0.0, 0.0)
	}

	@Test
	fun `pruneReputationFile does not clear offense streak by time`() {
		val data = ensureReputationShape(
			linkedMapOf<String, Any?>(
				"byNodeHash" to linkedMapOf<String, Any?>(
					PEER to linkedMapOf<String, Any?>("score" to -0.5, "offenseStreak" to 3.0, "lastOffenseAt" to 1000.0),
				),
				"wantUnknownHits" to ArrayList<Any?>(),
				"relayBumpSeen" to ArrayList<Any?>(),
			),
		)
		pruneReputationFile(data, tunables, 1000.0 + 86_400_000_000.0)
		assertEquals(3.0, repRow(data, PEER)["offenseStreak"] as Double, 0.0)
	}

	@Test
	fun `badInviteeCount increments and redeems via contribution`() {
		val data = newRepFile()
		incrementBadInviteeCount(data, PEER, 2.0)
		assertEquals(2.0, repRow(data, PEER)["badInviteeCount"] as Double, 0.0)
		val perBad = tunables["inviteRedemptionCreditPerBad"] as Double
		val relayBump = tunables["relayRepBump"] as Double
		for (i in 0 until Math.ceil(perBad * 2 / relayBump).toInt() + 1)
			bumpReputationOnRelayPure(data, PEER, "redeem:$i", 5000.0 + i, tunables)
		assertEquals(0.0, (repRow(data, PEER)["badInviteeCount"] as? Double) ?: 0.0, 0.0)
	}
}
