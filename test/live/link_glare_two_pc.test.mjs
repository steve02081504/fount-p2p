import { test } from 'node:test'

import { compareHex64Asc } from '../../core/hexIds.mjs'
import { registerDiscoveryProvider } from '../../discovery/index.mjs'
import { createLinkRegistry } from '../../transport/link_registry.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { createMockDiscoveryProvider } from '../helpers/mock_discovery.mjs'

import { identity, waitFor } from './helpers.mjs'

/**
 *
 */
async function runGlareRound() {
	const mock = createMockDiscoveryProvider('mock-glare-two-pc-discovery')
	const unregister = registerDiscoveryProvider(mock)
	const alice = identity(41)
	const bob = identity(42)
	const aliceRegistry = createLinkRegistry({
		localIdentity: alice,
		autoRegisterDiscoveryProviders: false,
		meshKeepalive: false,
	})
	const bobRegistry = createLinkRegistry({
		localIdentity: bob,
		autoRegisterDiscoveryProviders: false,
		meshKeepalive: false,
	})
	const aliceIsSmaller = compareHex64Asc(alice.nodeHash, bob.nodeHash) < 0
	try {
		await Promise.all([aliceRegistry.ensureRuntime(), bobRegistry.ensureRuntime()])
		await Promise.all([
			aliceRegistry.ensureLinkToNode(bob.nodeHash),
			bobRegistry.ensureLinkToNode(alice.nodeHash),
		])
		await waitFor(
			() => {
				const al = aliceRegistry.getLink(bob.nodeHash)
				const bl = bobRegistry.getLink(alice.nodeHash)
				if (!al || !bl) return false
				return al.initiator === aliceIsSmaller && bl.initiator === aliceIsSmaller
			},
			15_000,
		)
		const aliceLink = aliceRegistry.getLink(bob.nodeHash)
		const bobLink = bobRegistry.getLink(alice.nodeHash)
		assertEquals(aliceLink.initiator, aliceIsSmaller)
		assertEquals(bobLink.initiator, aliceIsSmaller)
	}
	finally {
		await aliceRegistry.shutdown()
		await bobRegistry.shutdown()
		unregister()
	}
}

test({
	name: 'offer/answer glare converges to single canonical link per side',
	sanitizeOps: false,
	sanitizeResources: false,
	fn: runGlareRound,
})
