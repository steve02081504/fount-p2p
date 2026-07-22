import { test } from 'node:test'

import { encryptAdvertForScope } from '../../discovery/adverts.mjs'
import { registerDiscoveryProvider, buildSignedAdvertForScope } from '../../discovery/index.mjs'
import { createLinkRegistry } from '../../transport/link_registry.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { createMockDiscoveryProvider } from '../helpers/mock_discovery.mjs'

import { identity, waitFor } from './helpers.mjs'

test({
	name: 'link registry uses discovery list+connect for adverts and nodeHash dialing',
	sanitizeOps: false,
	sanitizeResources: false,
	/**
	 *
	 */
	async fn() {
		const mock = createMockDiscoveryProvider()
		const unregister = registerDiscoveryProvider(mock)
		const alice = identity(11)
		const bob = identity(12)
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
		const adverts = []
		const received = []
		const stopAdvert = await aliceRegistry.watchNodeAdvert(bob.nodeHash, (verifiedNodeHash) => {
			adverts.push(verifiedNodeHash)
		})
		const stopNode = bobRegistry.subscribeScope('node', (senderNodeHash, envelope) => {
			received.push({ senderNodeHash, envelope })
		})
		try {
			await Promise.all([aliceRegistry.ensureRuntime(), bobRegistry.ensureRuntime()])
			const body = await buildSignedAdvertForScope('node', bob)
			const bytes = encryptAdvertForScope('node', bob, body)
			mock.publishAdvert(bob.nodeHash, bytes)
			await waitFor(() => adverts.includes(bob.nodeHash), 5_000)
			await aliceRegistry.ensureLinkToNode(bob.nodeHash)
			await aliceRegistry.sendToNodeLink(bob.nodeHash, {
				scope: 'node',
				action: 'mailbox_put',
				payload: { ok: true },
			})
			await waitFor(() => received.length, 10_000)
			assertEquals(received[0].senderNodeHash, alice.nodeHash)
			assertEquals(received[0].envelope.action, 'mailbox_put')
			assertEquals(received[0].envelope.payload.ok, true)
		}
		finally {
			stopAdvert()
			stopNode()
			await aliceRegistry.shutdown()
			await bobRegistry.shutdown()
			unregister()
		}
	},
})
