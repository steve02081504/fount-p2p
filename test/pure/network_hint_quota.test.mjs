import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { capHintsBySource, loadNetwork, normalizeNetwork, promoteExplorePeer, replaceNetworkPeerPools } from '../../node/network.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { initTestP2pNode } from '../helpers/node.mjs'

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

test('saveNetwork caps trustedPeers at 64', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'fount-p2p-trusted-cap-'))
	await mkdir(dir, { recursive: true })
	initTestP2pNode({ nodeDir: dir })
	const hashes = Array.from({ length: 80 }, (_, i) => {
		const n = i.toString(16).padStart(2, '0')
		return n.repeat(32).slice(0, 64)
	})
	replaceNetworkPeerPools({ trustedPeers: hashes, explorePeers: [] })
	assertEquals(loadNetwork().trustedPeers.length, 64)
	promoteExplorePeer(NODE)
	assertEquals(loadNetwork().trustedPeers.length, 64)
	assertEquals(loadNetwork().trustedPeers.includes(NODE), true)
	await rm(dir, { recursive: true, force: true })
})
