import { test } from 'node:test'

import { clearDiscoveryProviders } from '../../discovery/index.mjs'
import { clearLinkProviders, registerLinkProvider } from '../../link/providers/index.mjs'
import { createLinkRegistry } from '../../transport/link_registry.mjs'
import { assert, assertEquals } from '../helpers/assert.mjs'
import { identity } from '../helpers/identity.mjs'

test('setIceServers is visible to the next offer/answer dial', async () => {
	clearLinkProviders()
	clearDiscoveryProviders()
	/** @type {unknown[]} */
	const seenIce = []
	registerLinkProvider({
		id: 'probe-oa',
		priority: 1,
		caps: { needsOfferAnswer: true },
		/**
		 * @returns {Promise<boolean>} 探测 provider 可用
		 */
		async isAvailable() { return true },
		/**
		 * @returns {Promise<boolean>} 探测可达
		 */
		async canReach() { return true },
		/**
		 * @param {{ iceServers?: unknown }} options dial 选项
		 * @returns {Promise<null>} 拨号结果（测试中恒为 null）
		 */
		async dial(options) {
			seenIce.push(options.iceServers)
			return null
		},
		/**
		 * @returns {Promise<null>} 接受入站（测试中不处理）
		 */
		async accept() { return null },
	})
	const registry = createLinkRegistry({
		localIdentity: identity(41),
		iceServers: [{ urls: 'stun:initial.example:3478' }],
		autoRegisterDiscoveryProviders: false,
		autoRegisterLinkProviders: false,
		meshKeepalive: false,
	})
	try {
		await registry.ensureRuntime()
		await registry.ensureLinkToNode(identity(42).nodeHash)
		assert(seenIce.length >= 1, 'expected at least one dial')
		assertEquals(seenIce.at(-1), [{ urls: 'stun:initial.example:3478' }])
		const next = [{ urls: 'stun:rotated.example:3478' }]
		registry.setIceServers(next)
		assertEquals(registry.getIceServers(), next)
		await registry.ensureLinkToNode(identity(43).nodeHash)
		assert(seenIce.length >= 2, 'expected second dial after setIceServers')
		assertEquals(seenIce.at(-1), next)
	}
	finally {
		await registry.shutdown()
		clearLinkProviders()
		clearDiscoveryProviders()
	}
})
