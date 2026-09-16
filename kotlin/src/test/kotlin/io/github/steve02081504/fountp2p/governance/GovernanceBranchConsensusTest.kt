package io.github.steve02081504.fountp2p.governance

import io.github.steve02081504.fountp2p.registries.clearEventTypeRegistry
import io.github.steve02081504.fountp2p.registries.registerEventTypeDefs
import org.junit.Assert.assertEquals
import org.junit.Test

/** 等价 `test/pure/governance_branch_consensus.test.mjs`。 */
class GovernanceBranchConsensusTest {
	private fun byIdOf(events: List<Map<String, Any?>>): Map<String, Map<String, Any?>> {
		val out = LinkedHashMap<String, Map<String, Any?>>()
		for (event in events) out[event["id"] as String] = event
		return out
	}

	@Test
	fun `selectConsensusBranchTip picks branch with more governance events`() {
		clearEventTypeRegistry()
		registerEventTypeDefs("test", mapOf("slash" to mapOf<String, Any?>("governance" to true)))
		try {
			val root = "0".repeat(64)
			val leftTip = "1".repeat(64)
			val rightTip = "2".repeat(64)
			val leftGov = "3".repeat(64)
			val events = listOf(
				mapOf<String, Any?>("id" to leftTip, "type" to "message", "prev_event_ids" to listOf(leftGov)),
				mapOf<String, Any?>("id" to leftGov, "type" to "slash", "prev_event_ids" to listOf(root)),
				mapOf<String, Any?>("id" to rightTip, "type" to "message", "prev_event_ids" to listOf(root)),
				mapOf<String, Any?>("id" to root, "type" to "message", "prev_event_ids" to emptyList<String>()),
			)
			assertEquals(leftTip, selectConsensusBranchTip(listOf(leftTip, rightTip), byIdOf(events)))
		}
		finally {
			clearEventTypeRegistry()
		}
	}

	@Test
	fun `selectConsensusBranchTip tie-break prefers lexicographically larger tipId`() {
		clearEventTypeRegistry()
		try {
			val root = "0".repeat(64)
			val tipA = "1".repeat(64)
			val tipB = "2".repeat(64)
			val events = listOf(
				mapOf<String, Any?>("id" to tipA, "type" to "message", "prev_event_ids" to listOf(root)),
				mapOf<String, Any?>("id" to tipB, "type" to "message", "prev_event_ids" to listOf(root)),
				mapOf<String, Any?>("id" to root, "type" to "message", "prev_event_ids" to emptyList<String>()),
			)
			assertEquals(tipB, selectConsensusBranchTip(listOf(tipA, tipB), byIdOf(events)))
		}
		finally {
			clearEventTypeRegistry()
		}
	}

	@Test
	fun `authzFoldOrderIds keeps only branch ancestor chain`() {
		val root = "0".repeat(64)
		val left = "1".repeat(64)
		val right = "2".repeat(64)
		val tip = "3".repeat(64)
		val events = listOf(
			mapOf<String, Any?>("id" to tip, "type" to "message", "prev_event_ids" to listOf(left)),
			mapOf<String, Any?>("id" to left, "type" to "message", "prev_event_ids" to listOf(root)),
			mapOf<String, Any?>("id" to right, "type" to "message", "prev_event_ids" to listOf(root)),
			mapOf<String, Any?>("id" to root, "type" to "message", "prev_event_ids" to emptyList<String>()),
		)
		val order = listOf(root, left, right, tip)
		assertEquals(listOf(root, left, tip), authzFoldOrderIds(order, byIdOf(events), tip))
	}

	@Test
	fun `selectAuthzBranchTip respects preferred tip`() {
		clearEventTypeRegistry()
		try {
			val root = "0".repeat(64)
			val tipA = "1".repeat(64)
			val tipB = "2".repeat(64)
			val events = listOf(
				mapOf<String, Any?>("id" to tipA, "type" to "message", "prev_event_ids" to listOf(root)),
				mapOf<String, Any?>("id" to tipB, "type" to "message", "prev_event_ids" to listOf(root)),
				mapOf<String, Any?>("id" to root, "type" to "message", "prev_event_ids" to emptyList<String>()),
			)
			assertEquals(tipA, selectAuthzBranchTip(listOf(tipA, tipB), byIdOf(events), emptyMap(), tipA))
		}
		finally {
			clearEventTypeRegistry()
		}
	}
}
