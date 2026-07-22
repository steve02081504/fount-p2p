import { test } from 'node:test'

import { registerDiscoveryProvider } from '../../discovery/index.mjs'
import { createGroupLinkSet } from '../../transport/group_link_set.mjs'
import { createLinkRegistry } from '../../transport/link_registry.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { createMockDiscoveryProvider } from '../helpers/mock_discovery.mjs'

import { identity, waitFor } from './helpers.mjs'

test({
	name: 'group link set discovers via roomSecret scan and carries group envelopes',
	sanitizeOps: false,
	sanitizeResources: false,
	/**
	 *
	 */
	async fn() {
		const mock = createMockDiscoveryProvider('mock-group-discovery')
		const unregister = registerDiscoveryProvider(mock)
		const alice = identity(21)
		const bob = identity(22)
		const roomSecret = 'shared-room-secret'
		const members = [alice.nodeHash, bob.nodeHash]
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
		const aliceGroup = createGroupLinkSet({ groupId: 'g1', roomSecret, members, registry: aliceRegistry, autoconnect: false })
		const bobGroup = createGroupLinkSet({ groupId: 'g1', roomSecret, members, registry: bobRegistry, autoconnect: false })
		const received = []
		const off = bobGroup.onEnvelope((senderNodeHash, envelope) => {
			received.push({ senderNodeHash, envelope })
		})
		try {
			await Promise.all([aliceRegistry.ensureRuntime(), bobRegistry.ensureRuntime()])
			await Promise.all([aliceGroup.start(), bobGroup.start()])
			await aliceRegistry.ensureLinkToNode(bob.nodeHash)
			await waitFor(
				() => !!aliceRegistry.getLink(bob.nodeHash) && !!bobRegistry.getLink(alice.nodeHash),
				30_000,
			)
			assertEquals(await aliceGroup.send('dag_event', { hello: 'group' }), 1)
			await waitFor(() => received.length, 30_000)
			assertEquals(received[0].senderNodeHash, alice.nodeHash)
			assertEquals(received[0].envelope.scope, 'group:g1')
			assertEquals(received[0].envelope.action, 'dag_event')
			assertEquals(received[0].envelope.payload.hello, 'group')
		}
		finally {
			off()
			await aliceGroup.leave()
			await bobGroup.leave()
			await aliceRegistry.shutdown()
			await bobRegistry.shutdown()
			unregister()
		}
	},
})
