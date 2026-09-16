package io.github.steve02081504.fountp2p.governance

import org.junit.Assert.assertEquals
import org.junit.Test

/** DAG 悬挂父检测单元测试（等价 `test/pure/governance_dangling.test.mjs`）。 */
class GovernanceDanglingTest {
	private val a = "a".repeat(64)
	private val b = "b".repeat(64)
	private val c = "c".repeat(64)

	@Test
	fun `hasDanglingParents empty events`() {
		assertEquals(false, hasDanglingParents(emptyList()))
	}

	@Test
	fun `hasDanglingParents root event without parents`() {
		assertEquals(false, hasDanglingParents(listOf(mapOf<String, Any?>("id" to a, "prev_event_ids" to emptyList<String>()))))
	}

	@Test
	fun `hasDanglingParents complete chain`() {
		assertEquals(
			false,
			hasDanglingParents(
				listOf(
					mapOf<String, Any?>("id" to a, "prev_event_ids" to emptyList<String>()),
					mapOf<String, Any?>("id" to b, "prev_event_ids" to listOf(a)),
				),
			),
		)
	}

	@Test
	fun `hasDanglingParents missing parent reference`() {
		assertEquals(
			true,
			hasDanglingParents(listOf(mapOf<String, Any?>("id" to b, "prev_event_ids" to listOf(a)))),
		)
	}

	@Test
	fun `hasDanglingParents tip with dangling ancestor gap`() {
		assertEquals(
			true,
			hasDanglingParents(
				listOf(
					mapOf<String, Any?>("id" to a, "prev_event_ids" to emptyList<String>()),
					mapOf<String, Any?>("id" to c, "prev_event_ids" to listOf(b)),
				),
			),
		)
	}
}
