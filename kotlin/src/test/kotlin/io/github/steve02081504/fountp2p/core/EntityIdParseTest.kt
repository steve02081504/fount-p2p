package io.github.steve02081504.fountp2p.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 等价 `test/pure/entity_id_parse.test.mjs`。 */
class EntityIdParseTest {
	private val node = "b".repeat(64)
	private val subject = "c".repeat(64)
	private val entity = node + subject

	@Test
	fun `entity_id_parse roundtrip`() {
		assertEquals(entity, isEntityHash128(entity))
		val parsed = parseEntityHash(entity)!!
		assertEquals(entity, parsed.entityHash)
		assertEquals(node, parsed.nodeHash)
		assertEquals(subject, parsed.subjectHash)
		assertEquals(entity, encodeEntityHash(node, subject))
	}

	@Test
	fun `entity_id_parse rejects malformed input`() {
		assertNull(isEntityHash128("short"))
		assertNull(parseEntityHash(""))
	}
}
