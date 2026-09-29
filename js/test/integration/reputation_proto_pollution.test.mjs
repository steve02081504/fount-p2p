import { mkdir } from 'node:fs/promises'
import { test } from 'node:test'

import { observePeerBehavior, recordMessageRateViolation } from '../../node/reputation_store.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { initTestP2pNode } from '../helpers/node.mjs'
import { mkTestNodeDir, teardownTestNodeDir } from '../helpers/node_dir_leak.mjs'

const PEER = 'e'.repeat(64)
/** 会被 JS 原型语义拦截的危险键。 */
const PROTO_KEY = '__proto__'
/** 一旦发生原型污染会出现在 Object.prototype 上的字段。 */
const POLLUTED_KEYS = ['score', 'offenseStreak', 'lastOffenseAt', 'baseline', 'badInviteeCount', 'quarantinedUntil']

/** @returns {void} */
function assertObjectPrototypeClean() {
	for (const key of POLLUTED_KEYS)
		assertEquals(Object.hasOwn(Object.prototype, key), false, `Object.prototype.${key} should stay clean`)
}

test('unvalidated __proto__ peer key cannot pollute Object.prototype', async () => {
	const dir = await mkTestNodeDir('fount-rep-proto-')
	initTestP2pNode({ nodeDir: dir })
	await mkdir(dir, { recursive: true })
	try {
		await recordMessageRateViolation(PROTO_KEY, 1)
		await observePeerBehavior(PROTO_KEY, 5)
		assertObjectPrototypeClean()
		assertEquals(typeof {}.score, 'undefined')
	}
	finally {
		for (const key of POLLUTED_KEYS) delete Object.prototype[key]
		await teardownTestNodeDir(dir)
	}
})

test('legitimate hex peer key still updates its own reputation row', async () => {
	const dir = await mkTestNodeDir('fount-rep-proto-ok-')
	initTestP2pNode({ nodeDir: dir })
	await mkdir(dir, { recursive: true })
	try {
		await recordMessageRateViolation(PEER, 1)
		assertObjectPrototypeClean()
		const { loadReputation } = await import('../../node/reputation_store.mjs')
		const row = loadReputation().byNodeHash[PEER]
		assertEquals(!!row, true)
		assertEquals(Number(row.score) < 0, true)
	}
	finally {
		for (const key of POLLUTED_KEYS) delete Object.prototype[key]
		await teardownTestNodeDir(dir)
	}
})
