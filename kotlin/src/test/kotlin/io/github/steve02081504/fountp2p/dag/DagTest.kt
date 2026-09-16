package io.github.steve02081504.fountp2p.dag

import org.junit.Assert.assertEquals
import org.junit.Test

/** `dag/index.mjs` 等价测试（拓扑序部分）。 */
class DagTest {
	private fun hex(c: Char): String = c.toString().repeat(64)

	/**
	 * 等价 `test/pure/dag_prune_retention.test.mjs` 中的 DAG 断言：
	 * `topologicalCanonicalOrder` 对线性祖先链返回规范顺序。
	 * （该 JS 测试其余部分依赖 `governance/branch.mjs` 与 `node/retention_policy.mjs`，
	 * 属本移植范围外。）
	 */
	@Test
	fun `topologicalCanonicalOrder retains ancestor chain order`() {
		val e1 = hex('1')
		val e2 = hex('2')
		val e3 = hex('3')
		val e4 = hex('4')
		val events = listOf(
			mapOf<String, Any?>(
				"id" to e1,
				"type" to "message",
				"prev_event_ids" to emptyList<String>(),
				"hlc" to mapOf("wall" to 1.0, "logical" to 0.0),
			),
			mapOf<String, Any?>(
				"id" to e2,
				"type" to "message",
				"prev_event_ids" to listOf(e1),
				"hlc" to mapOf("wall" to 2.0, "logical" to 0.0),
			),
			mapOf<String, Any?>(
				"id" to e3,
				"type" to "message",
				"prev_event_ids" to listOf(e2),
				"hlc" to mapOf("wall" to 3.0, "logical" to 0.0),
			),
			mapOf<String, Any?>(
				"id" to e4,
				"type" to "message",
				"prev_event_ids" to listOf(e3),
				"hlc" to mapOf("wall" to 4.0, "logical" to 0.0),
			),
		)
		assertEquals(listOf(e1, e2, e3, e4), topologicalCanonicalOrder(events))
	}

	@Test
	fun `topologicalCanonicalOrder breaks ties by hlc then id`() {
		val a = hex('a')
		val b = hex('b')
		val events = listOf(
			mapOf<String, Any?>("id" to b, "prev_event_ids" to emptyList<String>(), "hlc" to mapOf("wall" to 1.0, "logical" to 0.0)),
			mapOf<String, Any?>("id" to a, "prev_event_ids" to emptyList<String>(), "hlc" to mapOf("wall" to 1.0, "logical" to 0.0)),
		)
		assertEquals(listOf(a, b), topologicalCanonicalOrder(events))
	}
}
