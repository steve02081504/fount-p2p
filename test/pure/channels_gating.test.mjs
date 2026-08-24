import { test } from 'node:test'

import { clearDiscoveryProviders, listDiscoveryProviders } from '../../discovery/index.mjs'
import { clearLinkProviders, listLinkProviders } from '../../link/providers/index.mjs'
import { setSignalingRuntimeConfig } from '../../node/instance.mjs'
import { disableAllChannels, resolveSignalingRuntimeConfig } from '../../node/signaling_config.mjs'
import { createLinkRegistry } from '../../transport/link_registry.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { identity } from '../helpers/identity.mjs'
import { initTestP2pNode } from '../helpers/node.mjs'
import { mkTestNodeDir, teardownTestNodeDir } from '../helpers/node_dir_leak.mjs'

/**
 * @param {string} dir nodeDir
 * @param {ReturnType<typeof identity>} localIdentity 本地身份
 * @returns {ReturnType<typeof createLinkRegistry>} registry
 */
function openRegistry(dir, localIdentity) {
	initTestP2pNode({ nodeDir: dir })
	return createLinkRegistry({
		localIdentity,
		autoRegisterDiscoveryProviders: true,
		autoRegisterLinkProviders: true,
		meshKeepalive: false,
	})
}

test('disableAllChannels re-enabling nostr registers only nostr + webrtc', async () => {
	clearLinkProviders()
	clearDiscoveryProviders()
	const nodeDir = await mkTestNodeDir('fount-p2p-channels-')
	try {
		const registry = openRegistry(nodeDir, identity(81))
		setSignalingRuntimeConfig({ channels: disableAllChannels({ nostr: true }) })
		await registry.ensureRuntime()
		assertEquals(listDiscoveryProviders().map(provider => provider.id).sort(), ['nostr'])
		assertEquals(
			listLinkProviders().map(provider => provider.id.split(':')[0]).sort(),
			['nostr', 'webrtc'],
		)
		await registry.shutdown()
	}
	finally {
		clearLinkProviders()
		clearDiscoveryProviders()
		await teardownTestNodeDir(nodeDir)
	}
})

test('omitted channels keeps all discovery/link channels active', async () => {
	clearLinkProviders()
	clearDiscoveryProviders()
	const nodeDir = await mkTestNodeDir('fount-p2p-channels-')
	try {
		const registry = openRegistry(nodeDir, identity(82))
		await registry.ensureRuntime()
		assertEquals(listDiscoveryProviders().map(provider => provider.id).sort(), ['lan', 'nostr'])
		assertEquals(
			listLinkProviders().map(provider => provider.id.split(':')[0]).sort(),
			['ble_gatt', 'lan_tcp', 'nostr', 'webrtc'],
		)
		await registry.shutdown()
	}
	finally {
		clearLinkProviders()
		clearDiscoveryProviders()
		await teardownTestNodeDir(nodeDir)
	}
})

test('channels { lan: false } disables only the lan channel', async () => {
	clearLinkProviders()
	clearDiscoveryProviders()
	const nodeDir = await mkTestNodeDir('fount-p2p-channels-')
	try {
		const registry = openRegistry(nodeDir, identity(83))
		setSignalingRuntimeConfig({ channels: { lan: false } })
		await registry.ensureRuntime()
		assertEquals(listDiscoveryProviders().map(provider => provider.id).sort(), ['nostr'])
		assertEquals(
			listLinkProviders().map(provider => provider.id.split(':')[0]).sort(),
			['ble_gatt', 'nostr', 'webrtc'],
		)
		await registry.shutdown()
	}
	finally {
		clearLinkProviders()
		clearDiscoveryProviders()
		await teardownTestNodeDir(nodeDir)
	}
})

test('resolve merges channel config; disableAllChannels off except overrides', () => {
	const config = resolveSignalingRuntimeConfig({
		channels: disableAllChannels({ nostr: { relay: ['wss://loopback/'] } }),
	})
	assertEquals(config.channels, {
		nostr: { relay: ['wss://loopback/'] },
		lan: false,
		bt: false,
	})
})
