package io.github.steve02081504.fountp2p.core

import org.junit.Assert.assertEquals
import org.junit.Test

/** 等价 `test/pure/logical_entity_browser.test.mjs`（稳定向量部分）。 */
class LogicalEntityTest {
	/** `logicalEntityHash('fount:chat:group:test')` 稳定向量（sentinel + SHA-256(subject)）。 */
	private val fountChatGroupTestEntityHash =
		"0000000000000000000000000000000000000000000000000000000000000000" +
			"b7829aed7b73408ad6e3c412bef8cb3afcf344bda185d50c0a7d573b8f0329b1"

	@Test
	fun `logicalEntityHash stable vector`() {
		val hash = logicalEntityHash("fount:chat:group:test")
		assertEquals(fountChatGroupTestEntityHash, hash)
		assertEquals(true, isLogicalEntityHash(hash))
		assertEquals(false, isLogicalEntityHash("a".repeat(128)))
	}
}
