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
 * @param {string} nodeDir nodeDir
 * @param {ReturnType<typeof identity>} localIdentity 本地身份
 * @returns {ReturnType<typeof createLinkRegistry>} registry
 */
function openRegistry(nodeDir, localIdentity) {
	initTestP2pNode({ nodeDir })
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

/** 当前全局 discovery / link provider 状态（bt runtime 在纯测试中不可用，故无 bt discovery）。 */
function channelState() {
	return {
		discovery: listDiscoveryProviders().map(provider => provider.id).sort(),
		link: listLinkProviders().map(provider => provider.id.split(':')[0]).sort(),
	}
}

/**
 * 用指定 channels 重载运行时。
 * @param {ReturnType<typeof createLinkRegistry>} registry registry
 * @param {Record<string, boolean>} channels 通道开关
 * @returns {Promise<void>}
 */
async function toggleChannels(registry, channels) {
	setSignalingRuntimeConfig({ channels })
	await registry.reloadDiscoveryRelays()
}

/**
 * 打开全通道注册的运行时并返回 state 断言对象。
 * @param {string} nodeDir nodeDir
 * @param {number} seed 身份种子
 * @returns {Promise<{ registry: ReturnType<typeof createLinkRegistry> }>} 句柄
 */
async function openAllChannels(nodeDir, seed) {
	clearLinkProviders()
	clearDiscoveryProviders()
	const registry = openRegistry(nodeDir, identity(seed))
	setSignalingRuntimeConfig({ channels: { nostr: true, lan: true, bt: true } })
	await registry.ensureRuntime()
	return { registry }
}

test('reload toggles nostr channel off and back on after startup', async () => {
	const nodeDir = await mkTestNodeDir('fount-p2p-channels-')
	try {
		const { registry } = await openAllChannels(nodeDir, 84)
		assertEquals(channelState(), { discovery: ['lan', 'nostr'], link: ['ble_gatt', 'lan_tcp', 'nostr', 'webrtc'] })
		await toggleChannels(registry, { nostr: false })
		assertEquals(channelState(), { discovery: ['lan'], link: ['ble_gatt', 'lan_tcp', 'webrtc'] })
		await toggleChannels(registry, { nostr: true })
		assertEquals(channelState(), { discovery: ['lan', 'nostr'], link: ['ble_gatt', 'lan_tcp', 'nostr', 'webrtc'] })
		await registry.shutdown()
	}
	finally {
		clearLinkProviders()
		clearDiscoveryProviders()
		await teardownTestNodeDir(nodeDir)
	}
})

test('reload toggles lan channel off and back on after startup', async () => {
	const nodeDir = await mkTestNodeDir('fount-p2p-channels-')
	try {
		const { registry } = await openAllChannels(nodeDir, 85)
		assertEquals(channelState(), { discovery: ['lan', 'nostr'], link: ['ble_gatt', 'lan_tcp', 'nostr', 'webrtc'] })
		await toggleChannels(registry, { lan: false })
		assertEquals(channelState(), { discovery: ['nostr'], link: ['ble_gatt', 'nostr', 'webrtc'] })
		await toggleChannels(registry, { lan: true })
		assertEquals(channelState(), { discovery: ['lan', 'nostr'], link: ['ble_gatt', 'lan_tcp', 'nostr', 'webrtc'] })
		await registry.shutdown()
	}
	finally {
		clearLinkProviders()
		clearDiscoveryProviders()
		await teardownTestNodeDir(nodeDir)
	}
})

test('reload toggles bt channel off and back on after startup', async () => {
	const nodeDir = await mkTestNodeDir('fount-p2p-channels-')
	try {
		const { registry } = await openAllChannels(nodeDir, 86)
		assertEquals(channelState(), { discovery: ['lan', 'nostr'], link: ['ble_gatt', 'lan_tcp', 'nostr', 'webrtc'] })
		await toggleChannels(registry, { bt: false })
		assertEquals(channelState(), { discovery: ['lan', 'nostr'], link: ['lan_tcp', 'nostr', 'webrtc'] })
		await toggleChannels(registry, { bt: true })
		assertEquals(channelState(), { discovery: ['lan', 'nostr'], link: ['ble_gatt', 'lan_tcp', 'nostr', 'webrtc'] })
		await registry.shutdown()
	}
	finally {
		clearLinkProviders()
		clearDiscoveryProviders()
		await teardownTestNodeDir(nodeDir)
	}
})
