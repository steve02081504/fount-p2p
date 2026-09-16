import { test } from 'node:test'

import {
	entriesForTargetEntityHash,
	isAuthorFilteredByPersonalSets,
	matchesPersonalListEntries,
	normalizePersonalListEntries,
} from '../../node/personal_block.mjs'
import { assertEquals } from '../helpers/assert.mjs'


const NODE_A = 'a'.repeat(64)
const SUBJ_C = 'c'.repeat(64)
const SUBJ_D = 'd'.repeat(64)
const USER_ENTITY = NODE_A + SUBJ_C
const AGENT_ENTITY = `${'b'.repeat(64)}${SUBJ_D}`

test('entriesForTargetEntityHash includes entity and subject', () => {
	const entries = entriesForTargetEntityHash(USER_ENTITY)
	assertEquals(entries.length, 2)
	assertEquals(entries.some(e => e.scope === 'entity' && e.value === USER_ENTITY), true)
	assertEquals(entries.some(e => e.scope === 'subject' && e.value === SUBJ_C), true)
})

test('matchesPersonalListEntries blocks by subject across nodes', () => {
	const entries = normalizePersonalListEntries([{ scope: 'subject', value: SUBJ_C }])
	const otherNodeEntity = `${'f'.repeat(64)}${SUBJ_C}`
	assertEquals(matchesPersonalListEntries(entries, { entityHash: otherNodeEntity }), true)
})

test('isAuthorFilteredByPersonalSets uses entity and subject sets', () => {
	const filterSets = {
		blockedEntityHashes: new Set([AGENT_ENTITY]),
		blockedSubjects: new Set(),
		hiddenEntityHashes: new Set(),
		hiddenSubjects: new Set(),
	}
	assertEquals(isAuthorFilteredByPersonalSets(filterSets, AGENT_ENTITY), true)
	assertEquals(isAuthorFilteredByPersonalSets(filterSets, USER_ENTITY), false)
})
