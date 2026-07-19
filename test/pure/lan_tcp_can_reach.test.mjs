import { test } from 'node:test'
import { setImmediate } from 'node:timers'

import { clearLanPeerHints, noteLanPeerHint } from '../../discovery/lan_peer_hints.mjs'
import { clearLinkProviders, registerLinkProvider } from '../../link/providers/index.mjs'
import { createLanTcpLinkProvider } from '../../link/providers/lan_tcp.mjs'
import { createLinkRegistry } from '../../transport/link_registry.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { identity } from '../helpers/identity.mjs'

test('lan_tcp skipped when no peer hint; mock lower provider used', async () => {
	clearLinkProviders()
	clearLanPeerHints()
	const dialed = []
	registerLinkProvider(createLanTcpLinkProvider())
	registerLinkProvider({
		id: 'mock-low',
		level: 10,
		caps: { needsOfferAnswer: false },
		/** @returns {boolean} 可用 */
		isAvailable: () => true,
		/** @returns {boolean} 可到达 */
		canReach: () => true,
		/**
		 * @param {object} options dial 选项
		 * @returns {Promise<object>} mock link
		 */
		async dial(options) {
			dialed.push('mock-low')
			const envelopeListeners = new Set()
			const downListeners = new Set()
			return {
				ready: Promise.resolve(),
				/** @returns {string} 对端 nodeHash */
				get nodeHash() { return options.nodeHash },
				/** @returns {boolean} 发起方 */
				get initiator() { return true },
				/** @returns {string} 提供者 id */
				get providerId() { return 'mock-low' },
				/** @returns {number} level */
				get level() { return 10 },
				/**
				 * @returns {Promise<boolean>} 始终成功
				 */
				async send() { return true },
				/**
				 * @param {Function} callback 回调
				 * @returns {() => void} 取消订阅
				 */
				onEnvelope(callback) {
					envelopeListeners.add(callback)
					return () => envelopeListeners.delete(callback)
				},
				/**
				 * @param {Function} callback 回调
				 * @returns {() => void} 取消订阅
				 */
				onDown(callback) {
					downListeners.add(callback)
					return () => downListeners.delete(callback)
				},
				/**
				 * @param {string} [reason] 原因
				 * @returns {Promise<void>}
				 */
				async close(reason = 'closed') {
					for (const listener of downListeners) listener(reason)
				},
				/**
				 * @returns {object} 空 stats
				 */
				stats() { return {} },
			}
		},
	})

	const alice = identity(31)
	const bob = identity(32)
	const registry = createLinkRegistry({
		localIdentity: alice,
		autoRegisterDiscoveryProviders: false,
		autoRegisterLinkProviders: false,
	})
	try {
		await registry.ensureRuntime()
		const link = await registry.ensureLinkToNode(bob.nodeHash)
		assertEquals(dialed, ['mock-low'])
		assertEquals(link?.providerId, 'mock-low')

		noteLanPeerHint(bob.nodeHash, { host: '127.0.0.1', port: 1 })
		assertEquals(createLanTcpLinkProvider().canReach({ nodeHash: bob.nodeHash }), true)
	}
	finally {
		await registry.shutdown()
		clearLinkProviders()
		clearLanPeerHints()
	}
})

test('buildLocalAdvert includes lan_tcp listen port after ensureRuntime', async () => {
	clearLinkProviders()
	clearLanPeerHints()
	const alice = identity(33)
	const registry = createLinkRegistry({
		localIdentity: alice,
		autoRegisterDiscoveryProviders: false,
		autoRegisterLinkProviders: true,
	})
	try {
		await registry.ensureRuntime()
		const port = registry.lanTcpPort()
		assertEquals(typeof port, 'number')
		const advert = await registry.buildLocalAdvert('test-topic')
		assertEquals(advert.tcpPort, port)
		assertEquals(advert.nodeHash, alice.nodeHash)
	}
	finally {
		await registry.shutdown()
		clearLinkProviders()
		clearLanPeerHints()
	}
})

test('second registry ensureRuntime does not hijack first lan_tcp identity', async () => {
	clearLinkProviders()
	clearLanPeerHints()
	const alice = identity(51)
	const bob = identity(52)
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
	try {
		await aliceRegistry.ensureRuntime()
		const alicePort = aliceRegistry.lanTcpPort()
		await bobRegistry.ensureRuntime()
		assertEquals(aliceRegistry.lanTcpPort(), alicePort)
		assertEquals(typeof bobRegistry.lanTcpPort(), 'number')
		assertEquals(alicePort !== bobRegistry.lanTcpPort(), true)

		noteLanPeerHint(alice.nodeHash, { host: '127.0.0.1', port: alicePort })
		const link = await bobRegistry.ensureLinkToNode(alice.nodeHash)
		assertEquals(link?.providerId, 'lan_tcp')
		assertEquals(link?.nodeHash, alice.nodeHash)

		// 入站侧必须以 alice 身份完成握手，不能被 bob ensureRuntime 覆盖掉。
		for (let i = 0; i < 50 && !aliceRegistry.getLink(bob.nodeHash); i++)
			await new Promise(resolve => setImmediate(resolve))
		assertEquals(!!aliceRegistry.getLink(bob.nodeHash), true)
	}
	finally {
		await aliceRegistry.shutdown()
		await bobRegistry.shutdown()
		clearLinkProviders()
		clearLanPeerHints()
	}
})
