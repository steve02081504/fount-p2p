package io.github.steve02081504.fountp2p.transport

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 等价 `js/test/pure/offer_answer_budget.test.mjs`。
 *
 * 偏离：JS 用假的 `clear()` 标记观察淘汰；Kotlin [BufferedSignalSession] 无观察点，
 * 改为断言会话表剩余键。
 */
class OfferAnswerBudgetTest {
	private fun fakeSessions(count: Int): LinkedHashMap<String, BufferedSignalSession> {
		val map = LinkedHashMap<String, BufferedSignalSession>()
		for (index in 0 until count) map["conn-$index"] = BufferedSignalSession { }
		return map
	}

	@Test
	fun `ensureSignalSessionBudget evicts oldest sessions until below cap`() {
		val sessions = fakeSessions(3)
		ensureSignalSessionBudget(sessions, 3)
		assertEquals(2, sessions.size)
		assertEquals(listOf("conn-1", "conn-2"), sessions.keys.toList())
	}

	@Test
	fun `ensureSignalSessionBudget leaves room when under cap`() {
		val sessions = fakeSessions(2)
		ensureSignalSessionBudget(sessions, 5)
		assertEquals(2, sessions.size)
		assertEquals(listOf("conn-0", "conn-1"), sessions.keys.toList())
	}

	@Test
	fun `ensureSignalSessionBudget clamps invalid cap to at least one`() {
		val sessions = fakeSessions(2)
		ensureSignalSessionBudget(sessions, 0)
		assertEquals(0, sessions.size)
	}
}
