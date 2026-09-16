import { test } from 'node:test'



import {
	countAchievedLeadingZeroBits,
	joinPowHashMeetsDifficulty,
	JOIN_POW_DEFAULT_EPOCH_MS,
	powVoluntaryBonus,
	solveJoinPow,
	verifyJoinPow,
} from '../../governance/join_pow.mjs'
import admissionTunables from '../../governance/tunables.json' with { type: 'json' }
import { assertEquals } from '../helpers/assert.mjs'

const GROUP = 'g-test'
const ANCHOR = 'a'.repeat(64)
const JOINER = 'b'.repeat(64)

test('joinPowHashMeetsDifficulty checks leading zero bits', () => {
	assertEquals(joinPowHashMeetsDifficulty('0000ffff', 16), true)
	assertEquals(joinPowHashMeetsDifficulty('0001ffff', 16), false)
	assertEquals(countAchievedLeadingZeroBits('0000000f'), 28)
})

test('verifyJoinPow accepts valid solution and returns achievedBits', () => {
	const epochMs = JOIN_POW_DEFAULT_EPOCH_MS
	const epoch = Math.floor(Date.now() / epochMs)
	const solution = solveJoinPow({
		groupId: GROUP,
		anchorRef: ANCHOR,
		joinerNodeHash: JOINER,
		epoch,
	}, 8)
	if (!solution) throw new Error('solveJoinPow failed')
	const { ok, achievedBits } = verifyJoinPow(solution, {
		groupId: GROUP,
		senderNodeHash: JOINER,
		knownAnchors: [ANCHOR],
		now: epoch * epochMs,
		difficultyBits: 8,
		epochMs,
	})
	assertEquals(ok, true)
	assertEquals(achievedBits >= 8, true)
})

test('verifyJoinPow rejects wrong anchor and sender binding', () => {
	const epochMs = JOIN_POW_DEFAULT_EPOCH_MS
	const epoch = Math.floor(Date.now() / epochMs)
	const solution = solveJoinPow({
		groupId: GROUP,
		anchorRef: ANCHOR,
		joinerNodeHash: JOINER,
		epoch,
	}, 6)
	if (!solution) throw new Error('solveJoinPow failed')
	assertEquals(verifyJoinPow(solution, {
		groupId: GROUP,
		senderNodeHash: JOINER,
		knownAnchors: ['c'.repeat(64)],
		difficultyBits: 6,
		epochMs,
		now: epoch * epochMs,
	}).ok, false)
	assertEquals(verifyJoinPow(solution, {
		groupId: GROUP,
		senderNodeHash: 'd'.repeat(64),
		knownAnchors: [ANCHOR],
		difficultyBits: 6,
		epochMs,
		now: epoch * epochMs,
	}).ok, false)
})

test('powVoluntaryBonus log-decays toward cap', () => {
	const floor = 18
	const cap = admissionTunables.powVoluntaryBonusCap
	const b0 = powVoluntaryBonus(floor, floor, admissionTunables)
	const b1 = powVoluntaryBonus(floor + 1, floor, admissionTunables)
	const b8 = powVoluntaryBonus(floor + 8, floor, admissionTunables)
	assertEquals(b0, 0)
	assertEquals(b1 > 0 && b1 < cap, true)
	assertEquals(b8 > b1 && b8 <= cap, true)
})
