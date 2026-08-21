import { test } from 'node:test'

import { normalizeHex64 } from '../../core/hexIds.mjs'
import {
	clearDiscoveryProviders,
	decryptNodeSignalPacket,
	registerDiscoveryProvider,
} from '../../discovery/index.mjs'
import {
	clearLinkProviders,
	LINK_LEVEL_NOSTR,
	listLinkProviders,
	registerLinkProvider,
} from '../../link/providers/index.mjs'
import { createNostrLinkProvider } from '../../link/providers/nostr.mjs'
import { createLinkRegistry } from '../../transport/link_registry.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { identity } from '../helpers/identity.mjs'

/**
 * 内存信令：sendNodeSignal 解密后交给对应 nostr link provider。
 * @param {{ alice: ReturnType<typeof identity>, bob: ReturnType<typeof identity>, aliceLink: object, bobLink: object }} ctx 两端
 * @returns {() => void} 注销 discovery
 */
function registerMemoryNostrDiscovery(ctx) {
	return registerDiscoveryProvider({
		id: 'nostr',
		priority: 100,
		caps: { canDiscover: true, canSignal: true },
		/**
		 * @param {string} toNodeHash 目标
		 * @param {Uint8Array} bytes 加密信令
		 * @returns {Promise<void>}
		 */
		async sendNodeSignal(toNodeHash, bytes) {
			const hash = normalizeHex64(toNodeHash)
			const packet = decryptNodeSignalPacket(hash, bytes)
			if (packet?.type !== 'link') return
			if (hash === ctx.alice.nodeHash) ctx.aliceLink.deliverPacket(packet)
			else if (hash === ctx.bob.nodeHash) ctx.bobLink.deliverPacket(packet)
		},
	})
}

test('LINK_LEVEL_NOSTR is -Infinity and sorts last', () => {
	assertEquals(LINK_LEVEL_NOSTR, Number.NEGATIVE_INFINITY)
	clearLinkProviders()
	registerLinkProvider({
		id: 'high',
		level: 80,
		/** @returns {boolean} 可用 */
		isAvailable: () => true,
		/**
		 * @returns {Promise<null>} 不建立连接
		 */
		async dial() { return null },
	})
	registerLinkProvider(createNostrLinkProvider({
		/**
		 * @returns {string[]} relay URL 列表
		 */
		getRelayUrls: () => ['ws://127.0.0.1:1'],
	}))
	registerLinkProvider({
		id: 'mid',
		level: 40,
		/** @returns {boolean} 可用 */
		isAvailable: () => true,
		/**
		 * @returns {Promise<null>} 不建立连接
		 */
		async dial() { return null },
	})
	try {
		assertEquals(listLinkProviders().map(provider => provider.id), ['high', 'mid', 'nostr'])
	}
	finally {
		clearLinkProviders()
	}
})

test('nostr link dial/accept exchanges an envelope over type:link', async () => {
	clearLinkProviders()
	clearDiscoveryProviders()
	const alice = identity(31)
	const bob = identity(32)
	const aliceLink = createNostrLinkProvider({
		/**
		 * @returns {string[]} relay URL 列表
		 */
		getRelayUrls: () => ['ws://memory'],
	})
	const bobLink = createNostrLinkProvider({
		/**
		 * @returns {string[]} relay URL 列表
		 */
		getRelayUrls: () => ['ws://memory'],
	})
	registerMemoryNostrDiscovery({ alice, bob, aliceLink, bobLink })

	/** @type {object | null} */
	let inbound = null
	const stopListen = bobLink.ensureListening({
		localIdentity: bob,
		/**
		 * @param {object} link 入站
		 * @returns {void}
		 */
		onInbound(link) { inbound = link },
	})
	aliceLink.ensureListening({
		localIdentity: alice,
		/** 忽略入站连接 */
		onInbound() { },
	})

	try {
		const dialed = await aliceLink.dial({ nodeHash: bob.nodeHash, localIdentity: alice })
		assertEquals(!!dialed, true)
		assertEquals(dialed.providerId, 'nostr')
		assertEquals(dialed.level, Number.NEGATIVE_INFINITY)
		await dialed.ready
		assertEquals(!!inbound, true)
		await inbound.ready
		assertEquals(inbound.nodeHash, alice.nodeHash)
		assertEquals(dialed.nodeHash, bob.nodeHash)

		/** @type {object | null} */
		let received = null
		inbound.onEnvelope(envelope => { received = envelope })
		assertEquals(await dialed.send({ scope: 'test', action: 'ping-payload', payload: { n: 1 } }), true)
		for (let i = 0; i < 50 && !received; i++)
			await new Promise(resolve => setTimeout(resolve, 10))
		assertEquals(received?.scope, 'test')
		assertEquals(received?.action, 'ping-payload')
		assertEquals(received?.payload?.n, 1)
	}
	finally {
		stopListen()
		clearDiscoveryProviders()
		clearLinkProviders()
	}
})

test('ensureLinkToNode falls back to nostr after higher providers fail', async () => {
	clearLinkProviders()
	clearDiscoveryProviders()
	const alice = identity(33)
	const bob = identity(34)
	const dialed = []
	registerLinkProvider({
		id: 'high-fail',
		level: 90,
		caps: { needsOfferAnswer: false },
		/** @returns {boolean} 可用 */
		isAvailable: () => true,
		/** @returns {boolean} 可到达 */
		canReach: () => true,
		/**
		 * @returns {Promise<null>} 拨号失败
		 */
		async dial() {
			dialed.push('high-fail')
			return null
		},
	})

	const aliceLink = createNostrLinkProvider({
		/**
		 * @returns {string[]} relay URL 列表
		 */
		getRelayUrls: () => ['ws://memory'],
	})
	const bobLink = createNostrLinkProvider({
		/**
		 * @returns {string[]} relay URL 列表
		 */
		getRelayUrls: () => ['ws://memory'],
	})
	registerMemoryNostrDiscovery({ alice, bob, aliceLink, bobLink })
	registerLinkProvider(aliceLink)

	bobLink.ensureListening({
		localIdentity: bob,
		/**
		 * @param {object} link 入站
		 * @returns {void}
		 */
		onInbound(link) {
			void link.ready.then(() => { }).catch(() => { })
		},
	})

	const registry = createLinkRegistry({
		localIdentity: alice,
		autoRegisterDiscoveryProviders: false,
		autoRegisterLinkProviders: false,
	})
	try {
		await registry.ensureRuntime()
		// 入站链也要挂到 bob 侧；本测试只验证 alice dial 顺序与 nostr 成功
		const originalDial = aliceLink.dial.bind(aliceLink)
		/**
		 * @param {object} options 拨号选项
		 * @returns {Promise<object | null>} 建立的 link
		 */
		aliceLink.dial = async options => {
			dialed.push('nostr')
			return originalDial(options)
		}
		const link = await registry.ensureLinkToNode(bob.nodeHash)
		assertEquals(dialed, ['high-fail', 'nostr'])
		assertEquals(link?.providerId, 'nostr')
		assertEquals(link?.level, Number.NEGATIVE_INFINITY)
		await link.ready
	}
	finally {
		await registry.shutdown()
		clearDiscoveryProviders()
		clearLinkProviders()
	}
})
