package io.github.steve02081504.fountp2p.transport

import io.github.steve02081504.fountp2p.node.PeerPoolView
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 等价 `test/pure/select_link_targets.test.mjs`。
 */
class SelectLinkTargetsTest {
	private val self = "s".repeat(64)
	private val a = "a".repeat(64)
	private val b = "b".repeat(64)
	private val c = "c".repeat(64)
	private val blocked = "e".repeat(64)
	private val quar = "f".repeat(64)
	private val anchor1 = "1".repeat(64)
	private val anchor2 = "2".repeat(64)

	private val emptyPeers = PeerPoolView()

	@Test
	fun `selectLinkTargetsFromMembers top-K trusted + explore filters self blocked quarantine`() {
		val limits = resolveFederationPoolLimits(mapOf<String, Any?>("trustedPeerSlots" to 2.0, "explorePeerSlots" to 2.0))
		val rep: Map<String, Any?> = mapOf(
			"byNodeHash" to mapOf<String, Any?>(
				a to mapOf<String, Any?>("score" to 0.9),
				b to mapOf<String, Any?>("score" to 0.5),
				c to mapOf<String, Any?>("score" to 0.1),
				quar to mapOf<String, Any?>("score" to 0.99, "quarantinedUntil" to System.currentTimeMillis().toDouble() + 1_000_000),
			),
		)
		val targets = selectLinkTargetsFromMembers(
			members = listOf(self, a, b, c, blocked, quar),
			selfNodeHash = self,
			rep = rep,
			peers = PeerPoolView(blockedPeers = listOf(blocked)),
			limits = limits,
		).toSet()
		assertEquals(true, targets.contains(a))
		assertEquals(true, targets.contains(b))
		assertEquals(true, targets.contains(c))
		assertEquals(false, targets.contains(self))
		assertEquals(false, targets.contains(blocked))
		assertEquals(false, targets.contains(quar))
	}

	@Test
	fun `selectLinkTargetsFromMembers anchors always connected even beyond trusted budget`() {
		val limits = resolveFederationPoolLimits(mapOf<String, Any?>("trustedPeerSlots" to 1.0))
		val rep: Map<String, Any?> = mapOf(
			"byNodeHash" to mapOf<String, Any?>(a to mapOf<String, Any?>("score" to 0.9)),
		)
		val targets = selectLinkTargetsFromMembers(
			members = listOf(anchor1, anchor2, a),
			selfNodeHash = self,
			rep = rep,
			peers = emptyPeers,
			limits = limits,
			anchors = listOf(anchor1, anchor2),
		).toSet()
		assertEquals(1, limits.trustedSlots)
		assertEquals(true, targets.contains(anchor1))
		assertEquals(true, targets.contains(anchor2))
	}

	@Test
	fun `selectLinkTargetsFromMembers explore fills remaining members when slots ample`() {
		val limits = resolveFederationPoolLimits(mapOf<String, Any?>("trustedPeerSlots" to 1.0, "explorePeerSlots" to 5.0))
		val rep: Map<String, Any?> = mapOf(
			"byNodeHash" to mapOf<String, Any?>(
				a to mapOf<String, Any?>("score" to 0.9),
				b to mapOf<String, Any?>("score" to 0.2),
				c to mapOf<String, Any?>("score" to 0.1),
			),
		)
		val targets = selectLinkTargetsFromMembers(
			members = listOf(a, b, c),
			selfNodeHash = self,
			rep = rep,
			peers = emptyPeers,
			limits = limits,
		).toSet()
		assertEquals(true, targets.contains(a))
		assertEquals(true, targets.contains(b))
		assertEquals(true, targets.contains(c))
	}

	@Test
	fun `selectLinkTargetsFromMembers empty members yields nothing`() {
		val limits = resolveFederationPoolLimits(emptyMap())
		assertEquals(
			0,
			selectLinkTargetsFromMembers(
				members = emptyList(),
				selfNodeHash = self,
				rep = emptyMap(),
				peers = emptyPeers,
				limits = limits,
			).size,
		)
	}
}
