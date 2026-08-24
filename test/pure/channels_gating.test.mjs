import { test } from 'node:test'

import { canUseBluetoothRuntime } from '../../discovery/bt/index.mjs'
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

/**
 * 当前全局 discovery / link provider 状态。
 * @returns {{ discovery: string[], link: string[] }} provider 状态
 */
function channelState() {
	return {
		discovery: listDiscoveryProviders().map(provider => provider.id).sort(),
		link: listLinkProviders().map(provider => provider.id.split(':')[0]).sort(),
	}
}

/**
 * 确保启用 channel 均可用（BT discovery 需显式 ensureChannelAvailable 才注册）。
 * @param {ReturnType<typeof createLinkRegistry>} registry registry
 * @param {Record<string, boolean> | undefined} channels 通道配置
 * @returns {Promise<void>}
 */
async function ensureEnabledChannels(registry, channels) {
	const config = resolveSignalingRuntimeConfig({ channels })
	for (const name of ['lan', 'nostr', 'bt', 'webrtc'])
		if (config.channels[name] !== false)
			await registry.ensureChannelAvailable(name)
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
	await ensureEnabledChannels(registry, channels)
}

/**
 * 打开指定 channels 的运行时，执行断言后清理。
 * ensureRuntime 只注册廉价 provider；BT discovery 需显式 ensureChannelAvailable 才注册。
 * @param {number} seed 身份种子
 * @param {Record<string, boolean> | undefined} channels 初始通道配置
 * @param {(registry: ReturnType<typeof createLinkRegistry>) => Promise<void>} run 断言回调
 * @returns {Promise<void>}
 */
async function withRuntime(seed, channels, run) {
	clearLinkProviders()
	clearDiscoveryProviders()
	const nodeDir = await mkTestNodeDir('fount-p2p-channels-')
	try {
		const registry = openRegistry(nodeDir, identity(seed))
		setSignalingRuntimeConfig({ channels })
		await registry.ensureRuntime()
		await ensureEnabledChannels(registry, channels)
		await run(registry)
		await registry.shutdown()
	}
	finally {
		clearLinkProviders()
		clearDiscoveryProviders()
		await teardownTestNodeDir(nodeDir)
	}
}

test('disableAllChannels re-enabling nostr registers only nostr + webrtc', async () => {
	await withRuntime(81, disableAllChannels({ nostr: true, webrtc: true }), async () => {
		assertEquals(listDiscoveryProviders().map(provider => provider.id).sort(), ['nostr'])
		assertEquals(listLinkProviders().map(provider => provider.id.split(':')[0]).sort(), ['nostr', 'webrtc'])
	})
})

test('omitted channels keeps all discovery/link channels active', async () => {
	const bt = await canUseBluetoothRuntime()
	await withRuntime(82, undefined, async () => {
		assertEquals(listDiscoveryProviders().map(provider => provider.id).sort(), ['lan', 'nostr', ...(bt ? ['bt'] : [])].sort())
		assertEquals(listLinkProviders().map(provider => provider.id.split(':')[0]).sort(), ['ble_gatt', 'lan_tcp', 'nostr', 'webrtc'])
	})
})

test('channels { lan: false } disables only the lan channel', async () => {
	const bt = await canUseBluetoothRuntime()
	await withRuntime(83, { lan: false }, async () => {
		assertEquals(listDiscoveryProviders().map(provider => provider.id).sort(), ['nostr', ...(bt ? ['bt'] : [])].sort())
		assertEquals(listLinkProviders().map(provider => provider.id.split(':')[0]).sort(), ['ble_gatt', 'nostr', 'webrtc'])
	})
})

test('channels { webrtc: false } drops the webrtc link fallback', async () => {
	await withRuntime(87, { nostr: true, lan: true, bt: false, webrtc: false }, async () => {
		assertEquals(listDiscoveryProviders().map(provider => provider.id).sort(), ['lan', 'nostr'])
		assertEquals(listLinkProviders().map(provider => provider.id.split(':')[0]).sort(), ['lan_tcp', 'nostr'])
	})
})

test('resolve merges channel config; disableAllChannels off except overrides', () => {
	const config = resolveSignalingRuntimeConfig({
		channels: disableAllChannels({ nostr: { relay: ['wss://loopback/'] } }),
	})
	assertEquals(config.channels, {
		nostr: { relay: ['wss://loopback/'] },
		lan: false,
		bt: false,
		webrtc: false,
	})
})

test('reload toggles nostr channel off and back on after startup', async () => {
	await withRuntime(84, { nostr: true, lan: true, bt: false }, async registry => {
		assertEquals(channelState(), { discovery: ['lan', 'nostr'], link: ['lan_tcp', 'nostr', 'webrtc'] })
		await toggleChannels(registry, { nostr: false, lan: true, bt: false })
		assertEquals(channelState(), { discovery: ['lan'], link: ['lan_tcp', 'webrtc'] })
		await toggleChannels(registry, { nostr: true, lan: true, bt: false })
		assertEquals(channelState(), { discovery: ['lan', 'nostr'], link: ['lan_tcp', 'nostr', 'webrtc'] })
	})
})

test('reload toggles lan channel off and back on after startup', async () => {
	await withRuntime(85, { nostr: true, lan: true, bt: false }, async registry => {
		assertEquals(channelState(), { discovery: ['lan', 'nostr'], link: ['lan_tcp', 'nostr', 'webrtc'] })
		await toggleChannels(registry, { nostr: true, lan: false, bt: false })
		assertEquals(channelState(), { discovery: ['nostr'], link: ['nostr', 'webrtc'] })
		await toggleChannels(registry, { nostr: true, lan: true, bt: false })
		assertEquals(channelState(), { discovery: ['lan', 'nostr'], link: ['lan_tcp', 'nostr', 'webrtc'] })
	})
})

test('reload toggles bt channel off and back on after startup', async () => {
	await withRuntime(86, { nostr: true, lan: true, bt: false }, async registry => {
		assertEquals(channelState(), { discovery: ['lan', 'nostr'], link: ['lan_tcp', 'nostr', 'webrtc'] })
		await toggleChannels(registry, { nostr: true, lan: true, bt: true })
		assertEquals(channelState(), { discovery: ['bt', 'lan', 'nostr'], link: ['ble_gatt', 'lan_tcp', 'nostr', 'webrtc'] })
		await toggleChannels(registry, { nostr: true, lan: true, bt: false })
		assertEquals(channelState(), { discovery: ['lan', 'nostr'], link: ['lan_tcp', 'nostr', 'webrtc'] })
	})
})
