import { test } from 'node:test'

import { capHintsBySource, normalizeNetwork } from '../../node/network.mjs'
import { assertEquals } from '../helpers/assert.mjs'



const NODE = `${'a'.repeat(64)}`

test('capHintsBySource limits per-source hints', () => {
	const hints = []
	for (let i = 0; i < 20; i++)
		hints.push({
			nodeHash: NODE,
			source: 'pex:flood',
			kind: 'pex',
			weight: 0.1,
			expiresAt: Date.now() + 1e6,
		})
	const capped = capHintsBySource(hints, 5)
	assertEquals(capped.length, 5)
	assertEquals(capped.every(h => h.source === 'pex:flood'), true)
})

test('normalizeNetwork still dedupes peers', () => {
	const net = normalizeNetwork({
		trustedPeers: [NODE],
		explorePeers: [],
		hints: [],
	})
	assertEquals(net.trustedPeers, [NODE])
})
