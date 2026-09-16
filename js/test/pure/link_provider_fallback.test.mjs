import { test } from 'node:test'
import { setImmediate } from 'node:timers'

import { clearLinkProviders, registerLinkProvider } from '../../link/providers/index.mjs'
import { createLinkRegistry } from '../../transport/link_registry.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { identity } from '../helpers/identity.mjs'

/**
 * 构造立即就绪的 mock link。
 * @param {object} options 选项
 * @returns {object} link 句柄
 */
function mockLink(options) {
	const envelopeListeners = new Set()
	const downListeners = new Set()
	const closed = { reason: null }
	return {
		ready: Promise.resolve(),
		/** @returns {string} 对端 nodeHash */
		get nodeHash() { return options.nodeHash },
		/** @returns {boolean} 是否发起方 */
		get initiator() { return !!options.initiator },
		/** @returns {string} 提供者 id */
		get providerId() { return options.providerId },
		/** @returns {number} 提供者 level */
		get level() { return options.level },
		/** @returns {string | null} 关闭原因 */
		get closedReason() { return closed.reason },
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
			closed.reason = reason
			for (const listener of downListeners) listener(reason)
		},
		/**
		 * @returns {object} 运行时 stats
		 */
		stats() { return { providerId: options.providerId } },
	}
}

test('ensureLinkToNode falls back by level when higher provider fails', async () => {
	clearLinkProviders()
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
		 * @returns {Promise<object>} 故意抛错
		 */
		async dial() {
			dialed.push('high-fail')
			throw new Error('simulated failure')
		},
	})
	registerLinkProvider({
		id: 'low-ok',
		level: 40,
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
			dialed.push('low-ok')
			return mockLink({
				providerId: 'low-ok',
				level: 40,
				initiator: true,
				nodeHash: options.nodeHash,
			})
		},
	})

	const alice = identity(21)
	const bob = identity(22)
	const registry = createLinkRegistry({
		localIdentity: alice,
		autoRegisterDiscoveryProviders: false,
		autoRegisterLinkProviders: false,
	})
	try {
		await registry.ensureRuntime()
		const link = await registry.ensureLinkToNode(bob.nodeHash)
		assertEquals(dialed, ['high-fail', 'low-ok'])
		assertEquals(link?.providerId, 'low-ok')
		assertEquals(link?.level, 40)
	}
	finally {
		await registry.shutdown()
		clearLinkProviders()
	}
})

test('canReach false skips dial entirely', async () => {
	clearLinkProviders()
	const dialed = []
	registerLinkProvider({
		id: 'unreachable',
		level: 90,
		caps: { needsOfferAnswer: false },
		/** @returns {boolean} 可用 */
		isAvailable: () => true,
		/** @returns {boolean} 不可达 */
		canReach: () => false,
		/**
		 * @returns {Promise<object>} 不应被调用
		 */
		async dial() {
			dialed.push('unreachable')
			throw new Error('should not dial')
		},
	})
	registerLinkProvider({
		id: 'reachable',
		level: 40,
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
			dialed.push('reachable')
			return mockLink({
				providerId: 'reachable',
				level: 40,
				initiator: true,
				nodeHash: options.nodeHash,
			})
		},
	})

	const alice = identity(27)
	const bob = identity(28)
	const registry = createLinkRegistry({
		localIdentity: alice,
		autoRegisterDiscoveryProviders: false,
		autoRegisterLinkProviders: false,
	})
	try {
		await registry.ensureRuntime()
		const link = await registry.ensureLinkToNode(bob.nodeHash)
		assertEquals(dialed, ['reachable'])
		assertEquals(link?.providerId, 'reachable')
	}
	finally {
		await registry.shutdown()
		clearLinkProviders()
	}
})

test('needsOfferAnswer soft-fail (null) continues to lower level', async () => {
	clearLinkProviders()
	const dialed = []
	registerLinkProvider({
		id: 'offer-soft',
		level: 70,
		caps: { needsOfferAnswer: true },
		/** @returns {boolean} 可用 */
		isAvailable: () => true,
		/** @returns {boolean} 可到达 */
		canReach: () => true,
		/**
		 * @returns {Promise<null>} soft-fail
		 */
		async dial() {
			dialed.push('offer-soft')
			return null
		},
		/**
		 * @returns {Promise<null>} soft-fail
		 */
		async accept() {
			return null
		},
	})
	registerLinkProvider({
		id: 'ble-ok',
		level: 40,
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
			dialed.push('ble-ok')
			return mockLink({
				providerId: 'ble-ok',
				level: 40,
				initiator: true,
				nodeHash: options.nodeHash,
			})
		},
	})

	const alice = identity(25)
	const bob = identity(26)
	const registry = createLinkRegistry({
		localIdentity: alice,
		autoRegisterDiscoveryProviders: false,
		autoRegisterLinkProviders: false,
	})
	try {
		await registry.ensureRuntime()
		const link = await registry.ensureLinkToNode(bob.nodeHash)
		assertEquals(dialed, ['offer-soft', 'ble-ok'])
		assertEquals(link?.providerId, 'ble-ok')
		assertEquals(link?.level, 40)
	}
	finally {
		await registry.shutdown()
		clearLinkProviders()
	}
})

test('inbound higher level replaces lower canonical link', async () => {
	clearLinkProviders()
	const alice = identity(23)
	const bob = identity(24)
	/** @type {((link: object) => void) | null} */
	let onInbound = null
	const lowLink = mockLink({
		providerId: 'low',
		level: 40,
		initiator: true,
		nodeHash: bob.nodeHash,
	})

	registerLinkProvider({
		id: 'inbound-high',
		level: 90,
		caps: { needsOfferAnswer: false },
		/** @returns {boolean} 可用 */
		isAvailable: () => true,
		/** @returns {boolean} 本用例仅入站 */
		canReach: () => false,
		/**
		 * @returns {Promise<object>} 本用例仅入站
		 */
		async dial() {
			throw new Error('inbound-high is accept-only in this test')
		},
		/**
		 * @param {{ onInbound: (link: object) => void }} handlers listening 回调
		 * @returns {Promise<() => void>} 停止 listening
		 */
		async ensureListening(handlers) {
			onInbound = handlers.onInbound
			return () => { onInbound = null }
		},
	})
	registerLinkProvider({
		id: 'low',
		level: 40,
		caps: { needsOfferAnswer: false },
		/** @returns {boolean} 可用 */
		isAvailable: () => true,
		/** @returns {boolean} 可到达 */
		canReach: () => true,
		/**
		 * @returns {Promise<object>} 低 level mock
		 */
		async dial() {
			return lowLink
		},
	})

	const registry = createLinkRegistry({
		localIdentity: alice,
		autoRegisterDiscoveryProviders: false,
		autoRegisterLinkProviders: false,
	})
	try {
		await registry.ensureRuntime()
		const first = await registry.ensureLinkToNode(bob.nodeHash)
		assertEquals(first?.providerId, 'low')
		assertEquals(typeof onInbound, 'function')

		const highLink = mockLink({
			providerId: 'inbound-high',
			level: 90,
			initiator: false,
			nodeHash: bob.nodeHash,
		})
		onInbound(highLink)
		// ensureListening 包装成 async registerResolvedLink；等到低 level 被关掉即可。
		for (let i = 0; i < 20 && lowLink.closedReason == null; i++)
			await new Promise(resolve => setImmediate(resolve))

		const canonical = registry.getLink(bob.nodeHash)
		assertEquals(canonical?.providerId, 'inbound-high')
		assertEquals(canonical?.level, 90)
		assertEquals(lowLink.closedReason, 'provider-replaced')
	}
	finally {
		await registry.shutdown()
		clearLinkProviders()
	}
})

test('ensureLinkToNode cools down after dial exhausted', async () => {
	clearLinkProviders()
	let dials = 0
	registerLinkProvider({
		id: 'always-miss',
		level: 50,
		caps: { needsOfferAnswer: false },
		/** @returns {boolean} 可用 */
		isAvailable: () => true,
		/** @returns {boolean} 可到达 */
		canReach: () => true,
		/**
		 * @returns {Promise<null>} 软失败
		 */
		async dial() {
			dials++
			return null
		},
	})
	const alice = identity(61)
	const bob = identity(62)
	const registry = createLinkRegistry({
		localIdentity: alice,
		autoRegisterDiscoveryProviders: false,
		autoRegisterLinkProviders: false,
		meshKeepalive: false,
	})
	try {
		await registry.ensureRuntime()
		assertEquals(await registry.ensureLinkToNode(bob.nodeHash), null)
		assertEquals(dials, 1)
		assertEquals(await registry.ensureLinkToNode(bob.nodeHash), null)
		assertEquals(dials, 1)
	}
	finally {
		await registry.shutdown()
		clearLinkProviders()
	}
})

test('ensureLinkToNode clears cooldown on discovery peer clue', async () => {
	const { noteDiscoveryPeerClue } = await import('../../discovery/peer_clue.mjs')
	clearLinkProviders()
	let dials = 0
	registerLinkProvider({
		id: 'always-miss',
		level: 50,
		caps: { needsOfferAnswer: false },
		/** @returns {boolean} 可用 */
		isAvailable: () => true,
		/** @returns {boolean} 可到达 */
		canReach: () => true,
		/**
		 * @returns {Promise<null>} 软失败
		 */
		async dial() {
			dials++
			return null
		},
	})
	const alice = identity(63)
	const bob = identity(64)
	const registry = createLinkRegistry({
		localIdentity: alice,
		autoRegisterDiscoveryProviders: false,
		autoRegisterLinkProviders: false,
		meshKeepalive: false,
	})
	try {
		await registry.ensureRuntime()
		assertEquals(await registry.ensureLinkToNode(bob.nodeHash), null)
		assertEquals(dials, 1)
		noteDiscoveryPeerClue(bob.nodeHash)
		assertEquals(await registry.ensureLinkToNode(bob.nodeHash), null)
		assertEquals(dials, 2)
	}
	finally {
		await registry.shutdown()
		clearLinkProviders()
	}
})
