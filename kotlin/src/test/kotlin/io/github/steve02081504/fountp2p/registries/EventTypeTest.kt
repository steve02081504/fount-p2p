package io.github.steve02081504.fountp2p.registries

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test

/** 等价 `test/pure/event_type.test.mjs`。 */
class EventTypeTest {
	@After
	fun tearDown() {
		clearEventTypeRegistry()
	}

	@Test
	fun `mergedEventTypeDefs merges owners with later owner overriding`() {
		clearEventTypeRegistry()
		registerEventTypeDefs(
			"a",
			mapOf(
				"message" to mapOf<String, Any?>("gcExclude" to true),
				"slash" to mapOf<String, Any?>("governance" to true),
			),
		)
		registerEventTypeDefs("b", mapOf("message" to mapOf<String, Any?>("permissionAnchor" to true)))
		try {
			assertEquals(
				mapOf(
					"message" to mapOf<String, Any?>("permissionAnchor" to true),
					"slash" to mapOf<String, Any?>("governance" to true),
				),
				mergedEventTypeDefs(),
			)
		}
		finally {
			clearEventTypeRegistry()
		}
	}

	@Test
	fun `typesWithFlag aggregates flags across merged defs`() {
		clearEventTypeRegistry()
		registerEventTypeDefs(
			"a",
			mapOf(
				"slash" to mapOf<String, Any?>("governance" to true),
				"invite" to mapOf<String, Any?>("permissionAnchor" to true),
			),
		)
		try {
			assertEquals(listOf("slash"), getGovernanceAuthzTypes().toList())
			assertEquals(listOf("invite"), getPermissionAnchorTypes().toList())
			assertEquals(emptyList<String>(), typesWithFlag("gcExclude").toList())
		}
		finally {
			clearEventTypeRegistry()
		}
	}

	@Test
	fun `unregisterEventTypeDefs removes owner defs`() {
		clearEventTypeRegistry()
		registerEventTypeDefs("a", mapOf("message" to mapOf<String, Any?>("gcExclude" to true)))
		unregisterEventTypeDefs("a")
		assertEquals(emptyMap<String, EventTypeFlags>(), mergedEventTypeDefs())
	}
}
