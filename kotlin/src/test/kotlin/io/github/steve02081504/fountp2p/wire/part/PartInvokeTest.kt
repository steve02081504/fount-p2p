package io.github.steve02081504.fountp2p.wire.part

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 等价 `js/test/integration/part_invoke.test.mjs` 与 `part_invoke_fanout.test.mjs` 中 wire 相关断言。 */
class PartInvokeTest {
	private fun result(value: Any?): Map<String, Any?> = mapOf("result" to value)

	private fun error(message: String, code: String): Map<String, Any?> =
		mapOf("error" to mapOf("message" to message, "code" to code))

	@Test
	fun `isPartInvokeResponse rejects empty and ambiguous shapes`() {
		assertEquals(false, isPartInvokeResponse(emptyMap<String, Any?>()))
		assertEquals(false, isPartInvokeResponse(result(1.0) + error("x", "X")))
		assertEquals(false, isPartInvokeResponse(mapOf("error" to mapOf("message" to "fail"))))
		assertTrue(isPartInvokeResponse(error("fail", "FAIL")))
		assertTrue(isPartInvokeResponse(result(mapOf("ok" to true))))
		assertEquals(false, isPartInvokeResponse(null))
	}

	@Test
	fun `unwrapPartInvokeResult returns result only on success`() {
		val ok = mapOf("ok" to true)
		assertEquals(ok, unwrapPartInvokeResult(result(ok)))
		assertNull(unwrapPartInvokeResult(error("nope", "NOPE")))
		assertNull(unwrapPartInvokeResult(result(null)))
		assertNull(unwrapPartInvokeResult(emptyMap<String, Any?>()))
		assertNull(unwrapPartInvokeResult(null))
	}

	@Test
	fun `isPartInvoke requires non-empty string kind`() {
		assertTrue(isPartInvoke(mapOf("kind" to "ping")))
		assertEquals(false, isPartInvoke(mapOf("kind" to "")))
		assertEquals(false, isPartInvoke(mapOf("kind" to 1.0)))
		assertEquals(false, isPartInvoke(emptyMap<String, Any?>()))
		assertEquals(false, isPartInvoke(null))
	}

	@Test
	fun `partInvokeDataRows and partInvokeErrorMessages split result and error`() {
		val rows = partInvokeDataRows(
			listOf(
				result(mapOf("ok" to 1.0)),
				error("nope", "NOPE"),
				result(mapOf("ok" to 2.0)),
			),
		)
		assertEquals(listOf(mapOf("ok" to 1.0), mapOf("ok" to 2.0)), rows)
		assertEquals(
			listOf("nope"),
			partInvokeErrorMessages(listOf(result(mapOf("ok" to 1.0)), error("nope", "NOPE"))),
		)
	}
}
