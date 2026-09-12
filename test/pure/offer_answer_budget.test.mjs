import { test } from 'node:test'

import { ensureSignalSessionBudget } from '../../transport/offer_answer.mjs'
import { assertEquals } from '../helpers/assert.mjs'

/**
 * @param {Array<{ cleared: boolean }>} flags 每会话的 clear 记录
 * @returns {Map<string, { clear: () => void }>} 假会话表
 */
function fakeSessions(flags) {
	const map = new Map()
	flags.forEach((flag, index) => {
		map.set(`conn-${index}`, {
			/** 标记该会话被清理 */
			clear() { flag.cleared = true },
		})
	})
	return map
}

test('ensureSignalSessionBudget evicts oldest sessions until below cap', () => {
	const flags = [{ cleared: false }, { cleared: false }, { cleared: false }]
	const sessions = fakeSessions(flags)
	ensureSignalSessionBudget(sessions, 3)
	assertEquals(sessions.size, 2)
	assertEquals(flags[0].cleared, true)
	assertEquals(flags[1].cleared, false)
})

test('ensureSignalSessionBudget leaves room when under cap', () => {
	const flags = [{ cleared: false }, { cleared: false }]
	const sessions = fakeSessions(flags)
	ensureSignalSessionBudget(sessions, 5)
	assertEquals(sessions.size, 2)
	assertEquals(flags[0].cleared, false)
})

test('ensureSignalSessionBudget clamps invalid cap to at least one', () => {
	const flags = [{ cleared: false }, { cleared: false }]
	const sessions = fakeSessions(flags)
	ensureSignalSessionBudget(sessions, 0)
	assertEquals(sessions.size, 0)
	assertEquals(flags[0].cleared, true)
	assertEquals(flags[1].cleared, true)
})
