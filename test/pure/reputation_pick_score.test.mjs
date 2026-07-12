import { test } from 'node:test'

import { pickNodeScoreFromReputation } from '../../reputation/pick_score.mjs'
import { assertEquals } from '../helpers/assert.mjs'



test('pickNodeScoreFromReputation returns global score only', () => {
	const peer = 'a'.repeat(64)
	const rep = {
		byNodeHash: {
			[peer]: { score: 0.4 },
		},
	}
	assertEquals(pickNodeScoreFromReputation(rep, peer), 0.4)
	assertEquals(pickNodeScoreFromReputation(rep, 'b'.repeat(64)), 0)
})
