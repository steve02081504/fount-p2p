package io.github.steve02081504.fountp2p.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** JSON 模型：JS 兼容的数字格式、canonical 排序与 undefined 语义。 */
class JsonTest {
	@Test
	fun `number formatting matches ECMAScript`() {
		assertEquals("0", Json.jsNumberToString(0.0))
		assertEquals("1", Json.jsNumberToString(1.0))
		assertEquals("-7", Json.jsNumberToString(-7.0))
		assertEquals("1.5", Json.jsNumberToString(1.5))
		assertEquals("100", Json.jsNumberToString(100.0))
		assertEquals("10000000000000000", Json.jsNumberToString(1e16))
		assertEquals("1e+21", Json.jsNumberToString(1e21))
		assertEquals("0.1", Json.jsNumberToString(0.1))
		assertEquals("0.00001", Json.jsNumberToString(1e-5))
		assertEquals("1e-7", Json.jsNumberToString(1e-7))
		assertEquals("null", Json.jsNumberToString(Double.NaN))
		assertEquals("null", Json.jsNumberToString(Double.POSITIVE_INFINITY))
	}

	@Test
	fun `canonical stringify sorts keys and preserves arrays`() {
		assertEquals("""{"a":2,"b":1}""", canonicalStringify(mapOf("b" to 1, "a" to 2)))
		assertEquals("[1,2,3]", canonicalStringify(listOf(1, 2, 3)))
	}

	@Test
	fun `undefined values are dropped from objects and nulled in arrays`() {
		assertEquals("""{"b":1}""", canonicalStringify(mapOf("a" to JsonUndefined, "b" to 1)))
		assertEquals("[null,1]", canonicalStringify(listOf(JsonUndefined, 1)))
	}

	@Test
	fun `stringify escapes control characters`() {
		assertEquals("\"a\\nb\"", Json.stringify("a\nb"))
		assertEquals("\"q\\\"q\"", Json.stringify("q\"q"))
	}

	@Test
	fun `parse and stringify roundtrip`() {
		val value = mapOf<String, Any?>("a" to 1.0, "b" to listOf("x", true, null), "c" to mapOf("d" to 2.0))
		val text = Json.stringify(value)
		assertEquals(value, Json.parse(text!!))
	}

	@Test
	fun `stringify returns null for top-level undefined`() {
		assertNull(Json.stringify(JsonUndefined))
	}
}
