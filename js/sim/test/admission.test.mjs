import { test } from 'node:test'

import { assertEquals } from '../../test/helpers/assert.mjs'
import {
	capMaliciousByPowBudget,
	honestJoinDelayPenalty,
	roundsPerIdentity,
} from '../admission.mjs'

test('roundsPerIdentity grows with difficulty', () => {
	const low = roundsPerIdentity(16)
	const high = roundsPerIdentity(20)
	assertEquals(high > low, true)
})

test('capMaliciousByPowBudget limits sybil count', () => {
	const capped = capMaliciousByPowBudget(100, 18, 40)
	assertEquals(capped < 100, true)
	assertEquals(capped >= 1, true)
})

test('honestJoinDelayPenalty is bounded 0..1', () => {
	const p = honestJoinDelayPenalty(18, 40)
	assertEquals(p >= 0 && p <= 1, true)
})
