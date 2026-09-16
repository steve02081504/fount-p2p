package io.github.steve02081504.fountp2p.wire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/** 等价 `js/test/integration/part_invoke.test.mjs` 中 wire 相关断言。 */
class IngressTest {
	private val id = "aa".repeat(32)
	private val signature = "bb".repeat(64)

	private fun signedRow(patch: Map<String, Any?> = emptyMap()): LinkedHashMap<String, Any?> =
		linkedMapOf<String, Any?>("id" to id, "signature" to signature).apply { putAll(patch) }

	@Test
	fun `parseInboundJson parses object frames and rejects non-objects`() {
		assertNull(parseInboundJson(null))
		assertNull(parseInboundJson(""))
		assertNull(parseInboundJson("not json"))
		assertNull(parseInboundJson("[1,2]"))
		assertNull(parseInboundJson("5"))
		val parsed = parseInboundJson("{\"a\":1}")
		assertNotNull(parsed)
		assertEquals(1.0, parsed!!["a"])
	}

	@Test
	fun `parseInboundJson accepts raw byte frames`() {
		val parsed = parseInboundJson("{\"kind\":\"ping\"}".toByteArray(Charsets.UTF_8))
		assertEquals("ping", parsed!!["kind"])
	}

	@Test
	fun `isSignedDagEventRow requires id and signature`() {
		assertEquals(true, isSignedDagEventRow(signedRow()))
		assertEquals(false, isSignedDagEventRow(signedRow().apply { remove("signature") }))
		assertEquals(false, isSignedDagEventRow(signedRow(mapOf("id" to "zz"))))
		assertEquals(false, isSignedDagEventRow(signedRow(mapOf("signature" to "zz"))))
		assertEquals(false, isSignedDagEventRow(null))
		assertEquals(false, isSignedDagEventRow(listOf(1.0)))
	}

	@Test
	fun `extractInboundSignedEvent enforces group context`() {
		val noGroup = signedRow()
		assertEquals(noGroup, extractInboundSignedEvent(noGroup, "group-1"))
		val matching = signedRow(mapOf("groupId" to "group-1"))
		assertEquals(matching, extractInboundSignedEvent(matching, "group-1"))
		val mismatched = signedRow(mapOf("groupId" to "group-2"))
		assertNull(extractInboundSignedEvent(mismatched, "group-1"))
		assertNull(extractInboundSignedEvent(mapOf<String, Any?>("id" to id), "group-1"))
	}
}
