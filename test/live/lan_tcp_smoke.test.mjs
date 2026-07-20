import { test } from 'node:test'

import { clearLanPeerHints, noteLanPeerHint } from '../../discovery/lan_peer_hints.mjs'
import { clearLinkProviders, listLinkProviders } from '../../link/providers/index.mjs'
import { createLinkRegistry } from '../../transport/link_registry.mjs'
import { assertEquals } from '../helpers/assert.mjs'

import { identity, waitFor } from './helpers.mjs'

/**
 * 收集当前已 listen 的 lan_tcp 端口。
 * @returns {Set<number>} 端口集合
 */
function lanListenPorts() {
	const ports = new Set()
	for (const provider of listLinkProviders()) {
		const endpoint = typeof provider.localEndpoint === 'function' ? provider.localEndpoint() : null
		if (endpoint?.port) ports.add(endpoint.port)
	}
	return ports
}

test({
	name: 'lan_tcp smoke: registry dial + envelope over loopback',
	sanitizeOps: false,
	sanitizeResources: false,
	/**
	 * @returns {Promise<void>}
	 */
	async fn() {
		clearLinkProviders()
		clearLanPeerHints()
		const alice = identity(41)
		const bob = identity(42)
		const aliceRegistry = createLinkRegistry({
			localIdentity: alice,
			autoRegisterDiscoveryProviders: false,
			autoRegisterLinkProviders: true,
		})
		const bobRegistry = createLinkRegistry({
			localIdentity: bob,
			autoRegisterDiscoveryProviders: false,
			autoRegisterLinkProviders: true,
		})
		const received = []
		const stopScope = bobRegistry.subscribeScope('node', (senderNodeHash, envelope) => {
			received.push({ senderNodeHash, envelope })
		})
		try {
			await aliceRegistry.ensureRuntime()
			await aliceRegistry.whenListening()
			const portsBeforeBob = lanListenPorts()
			await bobRegistry.ensureRuntime()
			await bobRegistry.whenListening()
			const bobPort = [...lanListenPorts()].find(port => !portsBeforeBob.has(port))
			assertEquals(typeof bobPort, 'number')
			noteLanPeerHint(bob.nodeHash, { host: '127.0.0.1', port: bobPort })

			const link = await aliceRegistry.ensureLinkToNode(bob.nodeHash)
			assertEquals(link?.providerId, 'lan_tcp')
			assertEquals(link?.nodeHash, bob.nodeHash)
			await waitFor(() => !!bobRegistry.getLink(alice.nodeHash), 5_000)

			await aliceRegistry.sendToNodeLink(bob.nodeHash, {
				scope: 'node',
				action: 'lan_tcp_smoke',
				payload: { n: 7 },
			})
			await waitFor(() => received.some(item => item.envelope?.action === 'lan_tcp_smoke'), 5_000)
			const hit = received.find(item => item.envelope?.action === 'lan_tcp_smoke')
			assertEquals(hit.senderNodeHash, alice.nodeHash)
			assertEquals(hit.envelope.payload.n, 7)
		}
		finally {
			stopScope()
			await aliceRegistry.shutdown()
			await bobRegistry.shutdown()
			clearLinkProviders()
			clearLanPeerHints()
		}
	},
})
