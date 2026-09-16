import { test } from 'node:test'

import { pickMeshEvictionVictim, resolveMeshPoolLimits, selectMeshLinkTargets } from '../../transport/peer_pool.mjs'
import { assertEquals } from '../helpers/assert.mjs'

const SELF = 'a'.repeat(64)
const T1 = '1'.repeat(64)
const T2 = '2'.repeat(64)
const E1 = 'e'.repeat(64)
const E2 = 'f'.repeat(64)
const E3 = '3'.repeat(64)
const BLOCKED = 'b'.repeat(64)
const QUAR = 'c'.repeat(64)

const tunables = { meshN: 8, meshKMax: 5, meshNLow: 4, meshKMaxLow: 2 }

test('resolveMeshPoolLimits: default vs low profile', () => {
	assertEquals(resolveMeshPoolLimits('default', tunables), { N: 8, K_max: 5 })
	assertEquals(resolveMeshPoolLimits('low', tunables), { N: 4, K_max: 2 })
})

test('selectMeshLinkTargets: K=0 fills explore only', () => {
	const limits = { N: 4, K_max: 0 }
	const targets = selectMeshLinkTargets({
		selfNodeHash: SELF,
		trustedPeers: [T1],
		exploreCandidates: [E1, E2, E3],
		limits,
		connectedHashes: new Set(),
		rep: { byNodeHash: {} },
		blockedPeers: [],
	})
	assertEquals(targets.includes(T1), false)
	assertEquals(targets.length, 3)
})

test('selectMeshLinkTargets: trusted first then explore quota', () => {
	const limits = { N: 3, K_max: 2 }
	const rep = {
		byNodeHash: {
			[T1]: { score: 0.9 },
			[T2]: { score: 0.8 },
			[E1]: { score: 0.1 },
			[E2]: { score: 0.05 },
		},
	}
	const targets = selectMeshLinkTargets({
		selfNodeHash: SELF,
		trustedPeers: [T1, T2],
		exploreCandidates: [E1, E2],
		limits,
		connectedHashes: new Set(),
		rep,
		blockedPeers: [BLOCKED],
	})
	assertEquals(targets.slice(0, 2), [T1, T2])
	assertEquals(targets.length, 3)
	assertEquals(new Set(targets).has(E1) || new Set(targets).has(E2), true)
})

test('selectMeshLinkTargets: filters blocked and quarantined', () => {
	const limits = { N: 4, K_max: 0 }
	const targets = selectMeshLinkTargets({
		selfNodeHash: SELF,
		trustedPeers: [],
		exploreCandidates: [E1, BLOCKED, QUAR],
		limits,
		connectedHashes: new Set(),
		rep: { byNodeHash: { [QUAR]: { score: 0.99, quarantinedUntil: Date.now() + 1_000_000 } } },
		blockedPeers: [BLOCKED],
	})
	assertEquals(targets, [E1])
})

test('selectMeshLinkTargets: when K trusted already connected, fill remaining with explore', () => {
	const limits = { N: 8, K_max: 5 }
	const connectedTrusted = [T1, T2, '4'.repeat(64), '5'.repeat(64), '6'.repeat(64)]
	const moreTrusted = ['7'.repeat(64), '8'.repeat(64), '9'.repeat(64)]
	const targets = selectMeshLinkTargets({
		selfNodeHash: SELF,
		trustedPeers: [...connectedTrusted, ...moreTrusted],
		exploreCandidates: [E1, E2, E3],
		limits,
		connectedHashes: new Set(connectedTrusted),
		rep: { byNodeHash: {} },
		blockedPeers: [],
	})
	assertEquals(targets.length, 3)
	assertEquals(targets.every(id => [E1, E2, E3].includes(id)), true)
	assertEquals(targets.some(id => moreTrusted.includes(id)), false)
})

test('selectMeshLinkTargets: when N explore connected, still dial trusted for rebalance', () => {
	const limits = { N: 4, K_max: 2 }
	const exploreConnected = [E1, E2, E3, 'd'.repeat(64)]
	const targets = selectMeshLinkTargets({
		selfNodeHash: SELF,
		trustedPeers: [T1, T2],
		exploreCandidates: exploreConnected,
		limits,
		connectedHashes: new Set(exploreConnected),
		rep: {
			byNodeHash: {
				[T1]: { score: 0.9 },
				[T2]: { score: 0.8 },
			},
		},
		blockedPeers: [],
	})
	assertEquals(targets, [T1, T2])
})

test('selectMeshLinkTargets: explore quota respects N-K when under capacity', () => {
	const limits = { N: 4, K_max: 2 }
	const targets = selectMeshLinkTargets({
		selfNodeHash: SELF,
		trustedPeers: [T1, T2],
		exploreCandidates: [E1, E2, E3],
		limits,
		connectedHashes: new Set([T1, T2]),
		rep: { byNodeHash: {} },
		blockedPeers: [],
	})
	assertEquals(targets.length, 2)
	assertEquals(targets.every(id => [E1, E2, E3].includes(id)), true)
})

test('pickMeshEvictionVictim: explore link evicted before trusted', () => {
	const explore = new Set([E1])
	const victim = pickMeshEvictionVictim([T1, E1], explore, [T1], () => 0)
	assertEquals(victim, E1)
})

test('pickMeshEvictionVictim: lower scope weight among trusted', () => {
	const victim = pickMeshEvictionVictim([T1, T2], new Set(), [T1, T2], hash => hash === T1 ? 2 : 1)
	assertEquals(victim, T2)
})
