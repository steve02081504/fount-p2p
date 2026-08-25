import { test } from 'node:test'

import { bytesToBase64 } from '../../core/bytes_codec.mjs'
import { normalizeHex64 } from '../../core/hexIds.mjs'
import { FRAME_HEADER_BYTES, MIN_FRAME_CHUNK_BYTES } from '../../link/frame.mjs'
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
import {
	createNostrLinkProvider,
	MAX_LINK_PAYLOAD_CHARS,
	MIN_USABLE_RELAY_CAP_CHARS,
	minUsablePayloadCap,
} from '../../link/providers/nostr.mjs'
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

test('minUsablePayloadCap ignores unusably-low relays and takes min of the rest', () => {
	// 过低 relay 无法承载最小帧，剔除后取剩余可用 relay 的最小值。
	const usable = 64 * 1024
	assertEquals(minUsablePayloadCap([1, MIN_USABLE_RELAY_CAP_CHARS - 1, usable, 1 * 1024 * 1024]), usable)
	assertEquals(minUsablePayloadCap([usable, 2 * usable]), usable)
	// 全部过低或无有效值时回退 null。
	assertEquals(minUsablePayloadCap([1, 2, MIN_USABLE_RELAY_CAP_CHARS - 1]), null)
	assertEquals(minUsablePayloadCap([null, undefined, NaN, 0]), null)
})

test('MIN_USABLE_RELAY_CAP_CHARS can carry a minimum-chunk frame and is below the default cap', () => {
	// 该下限的 base64 长度正好能装下最小帧（帧头 + 最小 chunk）。
	const frame = new Uint8Array(FRAME_HEADER_BYTES + MIN_FRAME_CHUNK_BYTES)
	assertEquals(bytesToBase64(frame).length === MIN_USABLE_RELAY_CAP_CHARS, true)
	assertEquals(MIN_USABLE_RELAY_CAP_CHARS < MAX_LINK_PAYLOAD_CHARS, true)
})

test('nostr link chunks and reassembles a large envelope under the payload cap', async () => {
	clearLinkProviders()
	clearDiscoveryProviders()
	const alice = identity(35)
	const bob = identity(36)
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
		await dialed.ready
		await inbound.ready

		// 旧 12KB base64 上限下会抛 `nostr link payload too large` 的大 envelope，现应切帧后完整送达。
		const big = { scope: 'test', action: 'big-payload', payload: { blob: 'A'.repeat(150_000) } }
		/** @type {object | null} */
		let received = null
		inbound.onEnvelope(envelope => { received = envelope })
		assertEquals(await dialed.send(big), true)
		for (let i = 0; i < 200 && !received; i++)
			await new Promise(resolve => setTimeout(resolve, 10))
		assertEquals(received?.scope, 'test')
		assertEquals(received?.action, 'big-payload')
		assertEquals(received?.payload?.blob?.length, 150_000)
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
