package io.github.steve02081504.fountp2p.transport

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 等价 `test/pure/peer_pool_anchor.test.mjs`。
 */
class PeerPoolAnchorTest {
	private val a = "a".repeat(64)
	private val b = "b".repeat(64)
	private val c = "c".repeat(64)
	private val d = "d".repeat(64)
	private val e = "e".repeat(64)
	private val limits = resolveFederationPoolLimits(mapOf<String, Any?>("trustedPeerSlots" to 3.0, "explorePeerSlots" to 4.0))

	@Test
	fun `mergeTrustedWithAnchors keeps low-rep anchors first`() {
		val rep: Map<String, Any?> = mapOf(
			"byNodeHash" to mapOf<String, Any?>(
				a to mapOf<String, Any?>("score" to 0.9),
				b to mapOf<String, Any?>("score" to 0.1),
				c to mapOf<String, Any?>("score" to 0.8),
			),
		)
		val ranked = listOf(a, c, b)
		val trusted = mergeTrustedWithAnchors(listOf(b), ranked, limits)
		assertEquals(b, trusted[0])
		assertEquals(true, trusted.contains(a))
	}

	@Test
	fun `selectExploreWithSourceQuota caps single source`() {
		val sources = linkedMapOf(
			a to "attacker",
			b to "attacker",
			c to "attacker",
			d to "honest",
			e to "honest",
		)
		val picked = selectExploreWithSourceQuota(listOf(a, b, c, d, e), sources, 4, EXPLORE_MAX_PER_SOURCE)
		val bySrc = HashMap<String, Int>()
		for (id in picked) {
			val source = sources[id]!!
			bySrc[source] = (bySrc[source] ?: 0) + 1
		}
		assertEquals(true, (bySrc["attacker"] ?: 0) <= EXPLORE_MAX_PER_SOURCE)
		assertEquals(4, picked.size)
	}
}
