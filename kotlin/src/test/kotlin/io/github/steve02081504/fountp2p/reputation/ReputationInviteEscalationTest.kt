package io.github.steve02081504.fountp2p.reputation

import org.junit.Assert.assertEquals
import org.junit.Test

/** 等价 `test/pure/reputation_invite_escalation.test.mjs`。 */
class ReputationInviteEscalationTest {
	private val tunables = defaultReputationTunables()
	private val BAD = "b".repeat(64)
	private val INTRO = "c".repeat(64)
	private val ROOT = "d".repeat(64)

	@Test
	fun `computeInviteEscalation scales with badInviteeCount`() {
		assertEquals(1.0, computeInviteEscalation(0.0, tunables), 0.0)
		assertEquals(1.5, computeInviteEscalation(1.0, tunables), 0.0)
		assertEquals(2.5, computeInviteEscalation(3.0, tunables), 0.0)
		assertEquals(tunables["inviteBadEscalationMax"] as Double, computeInviteEscalation(100.0, tunables), 0.0)
	}

	@Test
	fun `repeat bad invites increase slash penalty on same introducer`() {
		val data = newRepFile()
		repRows(data)[INTRO] = linkedMapOf<String, Any?>("score" to 1.0)
		val edges = listOf<Any?>(linkedMapOf<String, Any?>("from" to INTRO, "to" to BAD))
		applyDecayCollusionAfterSlashPure(data, BAD, edges, tunables)
		val first = rowScore(data, INTRO)
		incrementBadInviteeCount(data, INTRO, 2.0)
		applyDecayCollusionAfterSlashPure(data, BAD, edges, tunables)
		val second = rowScore(data, INTRO)
		assertEquals(true, first > 0.9)
		assertEquals(true, second < first - 0.05)
		assertEquals(true, (repRow(data, INTRO)["badInviteeCount"] as Double) >= 3)
	}

	@Test
	fun `deep chain gets extended hop when introducer has many bad invites`() {
		val data = ensureReputationShape(
			linkedMapOf<String, Any?>(
				"byNodeHash" to linkedMapOf<String, Any?>(
					ROOT to linkedMapOf<String, Any?>("score" to 1.0),
					INTRO to linkedMapOf<String, Any?>("score" to 1.0, "badInviteeCount" to 4.0),
				),
				"wantUnknownHits" to ArrayList<Any?>(),
				"relayBumpSeen" to ArrayList<Any?>(),
			),
		)
		val edges = listOf<Any?>(
			linkedMapOf<String, Any?>("from" to INTRO, "to" to BAD),
			linkedMapOf<String, Any?>("from" to ROOT, "to" to INTRO),
		)
		val applied = applyDecayCollusionAfterSlashPure(data, BAD, edges, tunables)
		val rootHit = applied.find { it.node == ROOT }
		assertEquals(true, rootHit != null)
		assertEquals(true, (rootHit?.dRep ?: 0.0) > 0)
	}
}
