package io.github.steve02081504.fountp2p.timeline

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * `timeline/materialize_runner.mjs` 行为测试（该 JS 模块无现成单测，按函数语义编写）。
 */
class MaterializeRunnerTest {
	private fun hex(c: Char): String = c.toString().repeat(64)

	private fun event(id: String, prev: List<String>, wall: Double, type: String = "message"): Map<String, Any?> =
		mapOf<String, Any?>(
			"id" to id,
			"type" to type,
			"prev_event_ids" to prev,
			"hlc" to mapOf("wall" to wall, "logical" to 0.0),
			"node_id" to "node-1",
		)

	private fun appendOrderReducer(): Pair<
		Map<String, (Map<String, Any?>, Map<String, Any?>) -> Map<String, Any?>>,
		() -> Map<String, Any?>,
	> {
		val reducers = mapOf<String, (Map<String, Any?>, Map<String, Any?>) -> Map<String, Any?>>(
			"message" to { state, event ->
				val seen = (state["seen"] as? List<*>)?.mapNotNull { it as? String }.orEmpty()
				mapOf("seen" to (seen + (event["id"] as String)))
			},
		)
		return reducers to { mapOf<String, Any?>("seen" to emptyList<String>()) }
	}

	@Test
	fun `materializeFromEvents folds in topological order`() {
		val e1 = hex('1')
		val e2 = hex('2')
		val e3 = hex('3')
		val events = listOf(
			event(e3, listOf(e2), 3.0),
			event(e1, emptyList(), 1.0),
			event(e2, listOf(e1), 2.0),
		)
		val (reducers, createInitialState) = appendOrderReducer()

		val result = materializeFromEvents(events, reducers, createInitialState)

		assertEquals(listOf(e1, e2, e3), result.order)
		assertEquals(listOf(e1, e2, e3), result.state["seen"])
	}

	@Test
	fun `materializeFromEvents skips events without reducer`() {
		val e1 = hex('1')
		val e2 = hex('2')
		val events = listOf(
			event(e1, emptyList(), 1.0, type = "other"),
			event(e2, listOf(e1), 2.0),
		)
		val (reducers, createInitialState) = appendOrderReducer()

		val result = materializeFromEvents(events, reducers, createInitialState)

		assertEquals(listOf(e1, e2), result.order)
		assertEquals(listOf(e2), result.state["seen"])
	}

	@Test
	fun `materializeFromEvents returns initial state for empty events`() {
		val (reducers, createInitialState) = appendOrderReducer()

		val result = materializeFromEvents(emptyList(), reducers, createInitialState)

		assertEquals(emptyList<String>(), result.order)
		assertEquals(emptyList<String>(), result.state["seen"])
	}
}
