package io.github.steve02081504.fountp2p.node

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 等价 `test/pure/personal_block.test.mjs`。
 */
class PersonalBlockTest {
	private val nodeA = "a".repeat(64)
	private val subjC = "c".repeat(64)
	private val subjD = "d".repeat(64)
	private val userEntity = nodeA + subjC
	private val agentEntity = "b".repeat(64) + subjD

	@Test
	fun `entriesForTargetEntityHash includes entity and subject`() {
		val entries = entriesForTargetEntityHash(userEntity)
		assertEquals(2, entries.size)
		assertEquals(true, entries.any { it.scope == "entity" && it.value == userEntity })
		assertEquals(true, entries.any { it.scope == "subject" && it.value == subjC })
	}

	@Test
	fun `matchesPersonalListEntries blocks by subject across nodes`() {
		val entries = normalizePersonalListEntries(listOf(mapOf("scope" to "subject", "value" to subjC)))
		val otherNodeEntity = "f".repeat(64) + subjC
		assertEquals(true, matchesPersonalListEntries(entries, mapOf("entityHash" to otherNodeEntity)))
	}

	@Test
	fun `isAuthorFilteredByPersonalSets uses entity and subject sets`() {
		val filterSets = PersonalFilterSets(
			blockedEntityHashes = linkedSetOf(agentEntity),
			blockedSubjects = linkedSetOf(),
			hiddenEntityHashes = linkedSetOf(),
			hiddenSubjects = linkedSetOf(),
		)
		assertEquals(true, isAuthorFilteredByPersonalSets(filterSets, agentEntity))
		assertEquals(false, isAuthorFilteredByPersonalSets(filterSets, userEntity))
	}
}
