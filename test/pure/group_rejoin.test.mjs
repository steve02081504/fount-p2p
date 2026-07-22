import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { clearDiscoveryProviders, registerDiscoveryProvider } from '../../discovery/index.mjs'
import { createGroupLinkSet } from '../../transport/group_link_set.mjs'
import { createLinkRegistry } from '../../transport/link_registry.mjs'
import { assert, assertEquals } from '../helpers/assert.mjs'
import { identity } from '../helpers/identity.mjs'
import { createMockDiscoveryProvider } from '../helpers/mock_discovery.mjs'
import { initTestP2pNode } from '../helpers/node.mjs'

test('group_link_set leave then start rejoins (active + subscriptions)', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'fount-p2p-rejoin-'))
	await mkdir(dir, { recursive: true })
	clearDiscoveryProviders()
	const mock = createMockDiscoveryProvider()
	registerDiscoveryProvider(mock)
	initTestP2pNode({ nodeDir: dir })
	const self = identity(51)
	const peer = identity(52)
	const roomSecret = 'rejoin-room'
	const registry = createLinkRegistry({
		localIdentity: self,
		autoRegisterDiscoveryProviders: false,
		autoRegisterLinkProviders: false,
		meshKeepalive: false,
	})
	/** @type {string[]} */
	const watched = []
	const originalWatch = mock.watchGroupAdverts?.bind(mock)
	/**
	 * @param {string} secret 房间密钥
	 * @param {(bytes: Uint8Array, meta: object) => void} onAdvert advert 回调
	 * @returns {Promise<() => void>} 取消监听；同时记录 secret 供断言重订阅
	 */
	mock.watchGroupAdverts = async (secret, onAdvert) => {
		watched.push(secret)
		return originalWatch ? originalWatch(secret, onAdvert) : () => { }
	}
	const group = createGroupLinkSet({
		groupId: 'rejoin',
		roomSecret,
		members: [self.nodeHash, peer.nodeHash],
		registry,
		autoconnect: false,
	})
	try {
		await registry.ensureRuntime()
		await group.start()
		assertEquals(group.isActive(), true)
		assertEquals(watched.length, 1)
		await group.leave()
		assertEquals(group.isActive(), false)
		await group.start()
		assertEquals(group.isActive(), true)
		assert(watched.length >= 2, `expected watch re-subscribed after rejoin, got ${watched.length}`)
	}
	finally {
		await group.leave().catch(() => { })
		await registry.shutdown()
		clearDiscoveryProviders()
		await rm(dir, { recursive: true, force: true })
	}
})
