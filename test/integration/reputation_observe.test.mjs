

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'


import { loadReputation, observePeerBehavior } from '../../node/reputation_store.mjs'
import { isQuarantinedPure } from '../../reputation/engine.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { initTestP2pNode } from '../helpers/node.mjs'

const PEER = 'c'.repeat(64)

test('observePeerBehavior awaits reputation mutation before returning', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'fount-rep-'))
	initTestP2pNode({ nodeDir: dir })
	await mkdir(dir, { recursive: true })
	try {
		for (let i = 0; i < 6; i++)
			await observePeerBehavior(PEER, 0.05)

		const anomaly = await observePeerBehavior(PEER, 5)
		assertEquals(anomaly, true)
		assertEquals(isQuarantinedPure(loadReputation(), PEER), true)
	}
	finally {
		await rm(dir, { recursive: true, force: true })
	}
})
