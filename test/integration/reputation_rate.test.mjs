import { mkdir } from 'node:fs/promises'
import { test } from 'node:test'


import { loadReputation, recordMessageRateViolation } from '../../node/reputation_store.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { initTestP2pNode } from '../helpers/node.mjs'
import { mkTestNodeDir, teardownTestNodeDir } from '../helpers/node_dir_leak.mjs'

const PEER = 'd'.repeat(64)

test('recordMessageRateViolation awaits persistence before returning', async () => {
	const dir = await mkTestNodeDir('fount-rep-rate-')
	initTestP2pNode({ nodeDir: dir })
	await mkdir(dir, { recursive: true })
	try {
		await recordMessageRateViolation(PEER, 1)
		const score = loadReputation().byNodeHash[PEER]?.score ?? 0
		assertEquals(score < -0.01, true)
	}
	finally {
		await teardownTestNodeDir(dir)
	}
})
