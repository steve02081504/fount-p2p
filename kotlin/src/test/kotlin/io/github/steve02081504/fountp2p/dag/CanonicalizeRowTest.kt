package io.github.steve02081504.fountp2p.dag

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** `dag/canonicalize_row.mjs`、`strip_extensions.mjs`、`event_query.mjs` 等价测试。 */
class CanonicalizeRowTest {
	private fun hex(c: Char): String = c.toString().repeat(64)

	@Test
	fun `canonicalizeRowContent validates hex64 fields`() {
		val content = mapOf<String, Any?>("sender" to hex('a'))
		val out = canonicalizeRowContent(content, setOf("sender")) as Map<*, *>
		assertEquals(hex('a'), out["sender"])

		val error = assertThrows(IllegalArgumentException::class.java) {
			canonicalizeRowContent(mapOf<String, Any?>("sender" to hex('A')), setOf("sender"))
		}
		assertEquals("sender must be 64 hex characters", error.message)
	}

	@Test
	fun `canonicalizeRowContent validates entityHash fields`() {
		val valid = hex('a') + hex('b')
		val out = canonicalizeRowContent(mapOf<String, Any?>("actor" to valid), emptySet(), setOf("actor"))
			as Map<*, *>
		assertEquals(valid, out["actor"])

		val error = assertThrows(IllegalArgumentException::class.java) {
			canonicalizeRowContent(mapOf<String, Any?>("actor" to hex('a')), emptySet(), setOf("actor"))
		}
		assertEquals("actor must be 128 hex characters", error.message)
	}

	@Test
	fun `canonicalizeRowContent canonicalizes content_ref contentHash`() {
		val out = canonicalizeRowContent(
			mapOf<String, Any?>("content_ref" to mapOf<String, Any?>("contentHash" to hex('c'))),
			emptySet(),
		) as Map<*, *>
		val ref = out["content_ref"] as Map<*, *>
		assertEquals(hex('c'), ref["contentHash"])
	}

	@Test
	fun `canonicalizeSignedRow validates id sender and prev ids`() {
		val row = canonicalizeSignedRow(
			mapOf<String, Any?>(
				"id" to hex('1'),
				"sender" to hex('2'),
				"prev_event_ids" to listOf(hex('3'), hex('4')),
			),
		)
		assertEquals(hex('1'), row["id"])
		assertEquals(hex('2'), row["sender"])
		assertEquals(listOf(hex('3'), hex('4')), row["prev_event_ids"])

		val error = assertThrows(IllegalArgumentException::class.java) {
			canonicalizeSignedRow(
				mapOf<String, Any?>(
					"id" to hex('1'),
					"sender" to hex('2'),
					"prev_event_ids" to listOf(hex('3'), "bad"),
				),
			)
		}
		assertEquals("prev_event_ids[1] must be 64 hex characters", error.message)
	}

	@Test
	fun `canonicalizeSignedRow applies prepare and content hex keys`() {
		val row = canonicalizeSignedRow(
			mapOf<String, Any?>("id" to hex('1'), "sender" to hex('2'), "content" to mapOf<String, Any?>("sender" to hex('3'))),
			SignedRowOptions(
				prepare = { event -> LinkedHashMap(event).apply { this["extra"] = true } },
				contentHexKeys = setOf("sender"),
			),
		)
		assertEquals(true, row["extra"])
		val content = row["content"] as Map<*, *>
		assertEquals(hex('3'), content["sender"])
	}

	@Test
	fun `stripDagEventLocalExtensions drops sidecar keys`() {
		val row = mapOf<String, Any?>("id" to "x", "receivedAt" to 1.0, "isRemote" to true, "type" to "message")
		val out = stripDagEventLocalExtensions(row)
		assertEquals(mapOf<String, Any?>("id" to "x", "type" to "message"), out)
		assertTrue(row.containsKey("receivedAt"))
	}

	@Test
	fun `findLastEventOfType returns latest match`() {
		val first = mapOf<String, Any?>("type" to "message", "n" to 1.0)
		val second = mapOf<String, Any?>("type" to "message", "n" to 2.0)
		val events = listOf(first, mapOf<String, Any?>("type" to "other"), second)
		val found = findLastEventOfType(events, "message")
		assertEquals(2, found!!.index)
		assertEquals(2.0, found.event["n"])
		assertNull(findLastEventOfType(events, "missing"))
	}
}
