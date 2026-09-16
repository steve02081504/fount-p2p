package io.github.steve02081504.fountp2p.node

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 等价 `test/pure/network_denylist_normalize.test.mjs`。
 */
class NetworkDenylistNormalizeTest {
	private val nodeA = "a".repeat(64)
	private val nodeB = "b".repeat(64)
	private val entity = "a".repeat(64) + "c".repeat(64)

	@Test
	fun `normalizeNetwork dedupes peers and drops invalid hints`() {
		val net = normalizeNetwork(
			mapOf(
				"trustedPeers" to listOf(nodeA, nodeA, nodeA.uppercase()),
				"explorePeers" to listOf(nodeB),
				"hints" to listOf(
					mapOf(
						"nodeHash" to nodeB,
						"source" to "social",
						"kind" to "mention",
						"expiresAt" to System.currentTimeMillis().toDouble() + 1e6,
					),
					mapOf("nodeHash" to "bad", "source" to "x", "kind" to "y", "expiresAt" to 0.0),
				),
			),
		)
		assertEquals(listOf(nodeA), net.trustedPeers)
		assertEquals(listOf(nodeB), net.explorePeers)
		assertEquals(1, net.hints.size)
		assertEquals(nodeB, net.hints[0].nodeHash)
	}

	@Test
	fun `normalizeDenylist entity scope requires 128 hex`() {
		val list = normalizeDenylist(
			mapOf(
				"blocked" to listOf(
					mapOf("scope" to "entity", "value" to entity),
					mapOf("scope" to "entity", "value" to "not-valid"),
					mapOf("scope" to "node", "value" to nodeA),
				),
			),
		)
		@Suppress("UNCHECKED_CAST")
		val blocked = list["blocked"] as List<Map<String, Any?>>
		assertEquals(2, blocked.size)
		assertEquals("entity", blocked[0]["scope"])
		assertEquals(entity, blocked[0]["value"])
		assertEquals("node", blocked[1]["scope"])
	}

	@Test
	fun `normalizeDenylist drops entity scope groupId`() {
		val list = normalizeDenylist(
			mapOf("blocked" to listOf(mapOf("scope" to "entity", "value" to entity, "groupId" to "g1"))),
		)
		@Suppress("UNCHECKED_CAST")
		val blocked = list["blocked"] as List<Map<String, Any?>>
		assertEquals(1, blocked.size)
		assertEquals(null, blocked[0]["groupId"])
	}

	@Test
	fun `isPeerPoolKeyBlocked matches deny scopes separately`() {
		val view = PeerPoolView(
			trustedPeers = emptyList(),
			explorePeers = emptyList(),
			blockedPeers = listOf(nodeA),
			deniedNodes = listOf(nodeA),
			deniedSubjects = listOf(nodeB),
			deniedEntities = listOf(entity),
			lastRosterAt = 0.0,
		)
		assertEquals(true, isPeerPoolKeyBlocked(view, nodeA))
		assertEquals(true, isPeerPoolKeyBlocked(view, nodeB))
		assertEquals(true, isPeerPoolKeyBlocked(view, entity))
		assertEquals(false, isPeerPoolKeyBlocked(view, "e".repeat(64)))
	}
}
