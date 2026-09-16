package io.github.steve02081504.fountp2p.node

import io.github.steve02081504.fountp2p.dag.topologicalCanonicalOrder
import io.github.steve02081504.fountp2p.governance.descendantClosureFromTip
import io.github.steve02081504.fountp2p.registries.getPermissionAnchorTypes
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * `test/pure/dag_prune_retention.test.mjs` 中治理/保留断言（`governance/branch.mjs`
 * 与 `node/retention_policy.mjs`）的等价测试。
 */
class RetentionPolicyTest {
	private fun hex(c: Char): String = c.toString().repeat(64)

	private fun byIdOf(events: List<Map<String, Any?>>): Map<String, Map<String, Any?>> {
		val out = LinkedHashMap<String, Map<String, Any?>>()
		for (event in events) out[event["id"] as String] = event
		return out
	}

	@Test
	fun `descendantClosureFromTip keeps connected suffix not topo slice orphans`() {
		val root = hex('0')
		val left = hex('1')
		val right = hex('2')
		val tip = hex('3')
		val orphan = hex('4')
		val events = listOf(
			mapOf<String, Any?>("id" to tip, "prev_event_ids" to listOf(left, right)),
			mapOf<String, Any?>("id" to orphan, "prev_event_ids" to listOf(left)),
			mapOf<String, Any?>("id" to left, "prev_event_ids" to listOf(root)),
			mapOf<String, Any?>("id" to right, "prev_event_ids" to listOf(root)),
			mapOf<String, Any?>("id" to root, "prev_event_ids" to emptyList<String>()),
		)
		val keep = descendantClosureFromTip(tip, byIdOf(events))
		assertEquals(true, keep.contains(tip))
		assertEquals(false, keep.contains(orphan))
		assertEquals(1, keep.size)
	}

	@Test
	fun `computeRetentionKeepIds depth retains ancestor chain on branch`() {
		val e1 = hex('1')
		val e2 = hex('2')
		val e3 = hex('3')
		val e4 = hex('4')
		val events = listOf(
			mapOf<String, Any?>("id" to e1, "type" to "message", "prev_event_ids" to emptyList<String>(), "hlc" to mapOf("wall" to 1.0, "logical" to 0.0)),
			mapOf<String, Any?>("id" to e2, "type" to "message", "prev_event_ids" to listOf(e1), "hlc" to mapOf("wall" to 2.0, "logical" to 0.0)),
			mapOf<String, Any?>("id" to e3, "type" to "message", "prev_event_ids" to listOf(e2), "hlc" to mapOf("wall" to 3.0, "logical" to 0.0)),
			mapOf<String, Any?>("id" to e4, "type" to "message", "prev_event_ids" to listOf(e3), "hlc" to mapOf("wall" to 4.0, "logical" to 0.0)),
		)
		val byId = byIdOf(events)
		val order = topologicalCanonicalOrder(events)
		val keep = computeRetentionKeepIds(
			order,
			byId,
			linkedMapOf(
				"maxDepth" to 2.0,
				"cutoffWall" to 0.0,
				"anchorTypes" to getPermissionAnchorTypes(),
				"branchTipId" to e4,
			),
		)
		assertEquals(4, keep.size)
	}
}
