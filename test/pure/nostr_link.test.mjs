import { test } from 'node:test'

import { bytesToBase64 } from '../../core/bytes_codec.mjs'
import { isHex64 } from '../../core/hexIds.mjs'
import {
	clearDiscoveryProviders,
	decryptNodeSignalPacket,
	registerDiscoveryProvider,
} from '../../discovery/index.mjs'
import { createNostrDiscoveryProvider } from '../../discovery/nostr/index.mjs'
import { FRAME_HEADER_BYTES, maxFrameChunkBytesForPayload } from '../../link/frame.mjs'
import {
	clearLinkProviders,
	LINK_LEVEL_NOSTR,
	listLinkProviders,
	registerLinkProvider,
} from '../../link/providers/index.mjs'
import {
	createNostrLinkProvider,
	estimateEventMessageBytes,
	MAX_LINK_PAYLOAD_CHARS,
	MIN_USABLE_RELAY_CAP_CHARS,
	minUsablePayloadCap,
} from '../../link/providers/nostr/index.mjs'
import { createLinkRegistry } from '../../transport/link_registry.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { startFakeRelay } from '../helpers/fake_relay.mjs'
import { identity } from '../helpers/identity.mjs'
import { waitFor } from '../live/helpers.mjs'

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
			const hash = isHex64(toNodeHash)
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
		await waitFor(() => !!received, 5_000)
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

test('two nodes exchange a link envelope through a single real relay', async () => {
	clearLinkProviders()
	clearDiscoveryProviders()
	const relay = await startFakeRelay(() => true, { broadcast: true })
	const relayUrl = `ws://127.0.0.1:${relay.port}`
	const alice = identity(37)
	const bob = identity(38)
	const aliceLink = createNostrLinkProvider({
		/**
		 * @returns {string[]} relay URL 列表
		 */
		getRelayUrls: () => [relayUrl],
	})
	const bobLink = createNostrLinkProvider({
		/**
		 * @returns {string[]} relay URL 列表
		 */
		getRelayUrls: () => [relayUrl],
	})
	const discovery = createNostrDiscoveryProvider({ relayUrls: [relayUrl], localNodeHash: alice.nodeHash })
	registerDiscoveryProvider(discovery)
	try {
		const stopAliceSignal = await discovery.listenNodeSignals(alice.nodeHash, bytes => {
			const packet = decryptNodeSignalPacket(alice.nodeHash, bytes)
			if (packet?.type === 'link') void aliceLink.deliverPacket(packet)
		})
		const stopBobSignal = await discovery.listenNodeSignals(bob.nodeHash, bytes => {
			const packet = decryptNodeSignalPacket(bob.nodeHash, bytes)
			if (packet?.type === 'link') void bobLink.deliverPacket(packet)
		})
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
			await dialed.ready
			await waitFor(() => !!inbound, 5_000)
			assertEquals(!!inbound, true)
			await inbound.ready
			assertEquals(inbound.nodeHash, alice.nodeHash)
			assertEquals(dialed.nodeHash, bob.nodeHash)

			/** @type {object | null} */
			let received = null
			inbound.onEnvelope(envelope => { received = envelope })
			assertEquals(await dialed.send({ scope: 'test', action: 'relay-ping', payload: { via: 'relay', n: 42 } }), true)
			await waitFor(() => !!received, 5_000)
			assertEquals(received?.scope, 'test')
			assertEquals(received?.action, 'relay-ping')
			assertEquals(received?.payload?.n, 42)
			assertEquals(relay.connectionCount(), 1, 'single shared relay socket carries both nodes')
		}
		finally {
			stopListen()
			stopAliceSignal()
			stopBobSignal()
		}
	}
	finally {
		discovery.dispose?.()
		await relay.stop()
		clearDiscoveryProviders()
		clearLinkProviders()
	}
})

test('two nodes link when only the trailing relay of each list overlaps', async () => {
	clearLinkProviders()
	clearDiscoveryProviders()
	/** @type {Array<Awaited<ReturnType<typeof startFakeRelay>>>} */
	const relays = []
	/**
	 * @param {number} count 数量
	 * @returns {Promise<string[]>} 新开 relay URL 列表
	 */
	const startRelays = async count => {
		const urls = []
		for (let i = 0; i < count; i++) {
			const relay = await startFakeRelay(() => true, { broadcast: true })
			relays.push(relay)
			urls.push(`ws://127.0.0.1:${relay.port}`)
		}
		return urls
	}
	/** @type {ReturnType<typeof createNostrDiscoveryProvider> | null} */
	let aliceProvider = null
	/** @type {ReturnType<typeof createNostrDiscoveryProvider> | null} */
	let bobProvider = null
	try {
		const commonUrl = (await startRelays(1))[0]
		const aliceRelays = [...await startRelays(6), commonUrl]
		const bobRelays = [...await startRelays(6), commonUrl]

		const alice = identity(41)
		const bob = identity(42)
		aliceProvider = createNostrDiscoveryProvider({ relayUrls: aliceRelays, localNodeHash: alice.nodeHash })
		bobProvider = createNostrDiscoveryProvider({ relayUrls: bobRelays, localNodeHash: bob.nodeHash })
		registerDiscoveryProvider({
			id: 'nostr',
			priority: 100,
			caps: { canSignal: true },
			/**
			 * @param {string} toNodeHash 目标
			 * @param {Uint8Array} bytes 加密信令
			 * @returns {Promise<void>}
			 */
			async sendNodeSignal(toNodeHash, bytes) {
				if (isHex64(toNodeHash) === alice.nodeHash) await aliceProvider.sendNodeSignal(toNodeHash, bytes)
				else await bobProvider.sendNodeSignal(toNodeHash, bytes)
			},
		})
		const aliceLink = createNostrLinkProvider({
			/**
			 * @returns {string[]} relay URL 列表
			 */
			getRelayUrls: () => aliceRelays,
		})
		const bobLink = createNostrLinkProvider({
			/**
			 * @returns {string[]} relay URL 列表
			 */
			getRelayUrls: () => bobRelays,
		})
		const stopAliceSignal = await aliceProvider.listenNodeSignals(alice.nodeHash, bytes => {
			const packet = decryptNodeSignalPacket(alice.nodeHash, bytes)
			if (packet?.type === 'link') void aliceLink.deliverPacket(packet)
		})
		const stopBobSignal = await bobProvider.listenNodeSignals(bob.nodeHash, bytes => {
			const packet = decryptNodeSignalPacket(bob.nodeHash, bytes)
			if (packet?.type === 'link') void bobLink.deliverPacket(packet)
		})
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
			await dialed.ready
			await waitFor(() => !!inbound, 5_000)
			assertEquals(!!inbound, true)
			await inbound.ready

			/** @type {object | null} */
			let received = null
			inbound.onEnvelope(envelope => { received = envelope })
			assertEquals(await dialed.send({ scope: 'test', action: 'tail-relay-ping', payload: { shared: 7 } }), true)
			await waitFor(() => !!received, 5_000)
			assertEquals(received?.scope, 'test')
			assertEquals(received?.action, 'tail-relay-ping')
			assertEquals(received?.payload?.shared, 7)

			const common = relays[0]
			assertEquals(new Set(common.publishedEvents.map(event => event.pubkey)).size, 2, 'both nodes crossed the shared relay')
			for (let i = 1; i < relays.length; i++)
				assertEquals(relays[i].connectionCount(), 1, `unique relay ${i} is only reachable from its own node`)
		}
		finally {
			stopListen()
			stopAliceSignal()
			stopBobSignal()
		}
	}
	finally {
		aliceProvider?.dispose?.()
		bobProvider?.dispose?.()
		for (const relay of relays) await relay.stop()
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
	// 该下限等于装下最小正 chunk（帧头 + 1 字节 chunk）的完整 EVENT 字节数。
	/**
	 * 将原始 chunk 包装为 link 广播事件，用于字节大小估算。
	 * @param {Uint8Array} frame 要嵌入的 chunk 负载。
	 * @returns {{type:string,op:string,from:string,linkId:string,payload:string}} 最小化的 link 事件包。
	 */
	const packetForFrame = frame => ({ type: 'link', op: 'b', from: 'aa'.repeat(32), linkId: 'bb'.repeat(32), payload: bytesToBase64(frame) })
	assertEquals(estimateEventMessageBytes(packetForFrame(new Uint8Array(FRAME_HEADER_BYTES + 1))), MIN_USABLE_RELAY_CAP_CHARS)
	assertEquals(MIN_USABLE_RELAY_CAP_CHARS < MAX_LINK_PAYLOAD_CHARS, true)
	// 小于 256 但为正数的 chunk 也能在该上限下承载（base64 粒度下 budget 为正且 < 256）。
	/**
	 * 将 chunk 编码为填充事件字符串，其字节数与 relay 消息估算值一致。
	 * @param {Uint8Array} frame 要计量的 chunk 负载。
	 * @returns {string} 与估算字节大小一致的填充字符串。
	 */
	const eventEncoder = frame => 'x'.repeat(estimateEventMessageBytes(packetForFrame(frame)))
	const budget = maxFrameChunkBytesForPayload(MIN_USABLE_RELAY_CAP_CHARS, eventEncoder)
	assertEquals(budget > 0, true)
	assertEquals(budget < 256, true)
	// 无法容纳完整 EVENT 的 cap（低 1）得到 0 chunk budget，应被 minUsablePayloadCap 剔除。
	assertEquals(maxFrameChunkBytesForPayload(MIN_USABLE_RELAY_CAP_CHARS - 1, eventEncoder), 0)
})

test('estimateEventMessageBytes measures the full EVENT message; chunk budget hits the cap exactly', () => {
	const cap = MAX_LINK_PAYLOAD_CHARS
	const from = 'aa'.repeat(32)
	const linkId = 'bb'.repeat(32)
	/**
	 * @param {Uint8Array} frame 完整帧（帧头 + chunk）
	 * @returns {object} 事件消息
	 */
	const packetForFrame = frame => ({ type: 'link', op: 'b', from, linkId, payload: bytesToBase64(frame) })
	const chunk = maxFrameChunkBytesForPayload(cap, frame => 'x'.repeat(estimateEventMessageBytes(packetForFrame(frame))))
	// 达到上限：整帧消息恰好不超过 cap。
	assertEquals(estimateEventMessageBytes(packetForFrame(new Uint8Array(FRAME_HEADER_BYTES + chunk))) <= cap, true)
	// 超出上限：多一字节 chunk 即超过。
	assertEquals(estimateEventMessageBytes(packetForFrame(new Uint8Array(FRAME_HEADER_BYTES + chunk + 1))) > cap, true)
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
		await waitFor(() => !!received, 5_000)
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
