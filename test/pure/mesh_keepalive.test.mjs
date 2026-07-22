import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { clearDiscoveryProviders, registerDiscoveryProvider } from '../../discovery/index.mjs'
import { createMeshKeepalive, isMeshIntentionalClose } from '../../transport/mesh_keepalive.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { identity } from '../helpers/identity.mjs'
import { createMockDiscoveryProvider } from '../helpers/mock_discovery.mjs'
import { initTestP2pNode } from '../helpers/node.mjs'

const SELF = identity(1)
const PEER = identity(2)
const OTHER = identity(3)

test('isMeshIntentionalClose covers budget/manual/shutdown', () => {
	assertEquals(isMeshIntentionalClose('budget-evict'), true)
	assertEquals(isMeshIntentionalClose('manual-close'), true)
	assertEquals(isMeshIntentionalClose('registry-shutdown'), true)
	assertEquals(isMeshIntentionalClose('inbound-no-nodehash'), true)
	assertEquals(isMeshIntentionalClose('remote-close'), false)
	assertEquals(isMeshIntentionalClose(''), false)
})

test('mesh keepalive: intentional close does not redial; unexpected down refills via tick', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'fount-p2p-mesh-ka-'))
	await mkdir(dir, { recursive: true })
	initTestP2pNode({ nodeDir: dir })
	clearDiscoveryProviders()
	const mock = createMockDiscoveryProvider()
	registerDiscoveryProvider(mock)
	mock.publishAdvert(PEER.nodeHash, new Uint8Array([1]))
	mock.publishAdvert(OTHER.nodeHash, new Uint8Array([1]))

	/** @type {Map<string, object>} */
	const links = new Map()
	/** @type {Set<(nodeHash: string, reason: string) => void>} */
	const downListeners = new Set()
	/** @type {Set<(nodeHash: string) => void>} */
	const upListeners = new Set()
	/** @type {string[]} */
	const dialed = []

	const registry = {
		localIdentity: SELF,
		/**
		 * @returns {Array<{ nodeHash: string, link: object }>} 当前链路列表
		 */
		listLinks: () => [...links.entries()].map(([nodeHash, link]) => ({ nodeHash, link })),
		/**
		 * @param {string} nodeHash 目标 nodeHash
		 * @returns {object | null} 已有链路或 null
		 */
		getLink: nodeHash => links.get(nodeHash) || null,
		/**
		 * @param {string} nodeHash 目标 nodeHash
		 * @returns {Promise<object>} 模拟建链并触发 link up
		 */
		ensureLinkToNode: async nodeHash => {
			dialed.push(nodeHash)
			const link = { nodeHash }
			links.set(nodeHash, link)
			for (const listener of upListeners) listener(nodeHash)
			return link
		},
		/**
		 * @param {(nodeHash: string) => void} listener link up 回调
		 * @returns {() => void} 取消订阅
		 */
		onLinkUp: listener => {
			upListeners.add(listener)
			return () => upListeners.delete(listener)
		},
		/**
		 * @param {(nodeHash: string, reason: string) => void} listener link down 回调
		 * @returns {() => void} 取消订阅
		 */
		onLinkDown: listener => {
			downListeners.add(listener)
			return () => downListeners.delete(listener)
		},
	}

	const ka = createMeshKeepalive({ registry, enabled: true })
	ka.start()
	await new Promise(r => setTimeout(r, 30))
	assertEquals(dialed.length >= 1, true)
	const afterStart = dialed.length

	links.delete(PEER.nodeHash)
	for (const listener of downListeners) listener(PEER.nodeHash, 'budget-evict')
	await new Promise(r => setTimeout(r, 30))
	assertEquals(dialed.length, afterStart)
	assertEquals(ka.exploreLinkHashes.has(PEER.nodeHash), false)

	links.delete(OTHER.nodeHash)
	for (const listener of downListeners) listener(OTHER.nodeHash, 'remote-hangup')
	await new Promise(r => setTimeout(r, 30))
	assertEquals(dialed.length > afterStart, true)

	await ka.stop()
	clearDiscoveryProviders()
	await rm(dir, { recursive: true, force: true })
})

test('mesh keepalive: rebalance tick evicts explore then dials trusted', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'fount-p2p-mesh-reb-'))
	await mkdir(dir, { recursive: true })
	initTestP2pNode({ nodeDir: dir })
	const { mergeNetworkPeerPools } = await import('../../node/network.mjs')
	mergeNetworkPeerPools({
		trustedPeers: [PEER.nodeHash],
		explorePeers: [],
	})
	clearDiscoveryProviders()

	/** @type {Map<string, { nodeHash: string, close: (reason: string) => Promise<void> }>} */
	const links = new Map()
	/** @type {Set<(nodeHash: string, reason: string) => void>} */
	const downListeners = new Set()
	/** @type {string[]} */
	const dialed = []
	/** @type {string[]} */
	const evicted = []

	const exploreHashes = [
		'e1'.repeat(32),
		'e2'.repeat(32),
		'e3'.repeat(32),
		'e4'.repeat(32),
		'e5'.repeat(32),
		'e6'.repeat(32),
		'e7'.repeat(32),
		'e8'.repeat(32),
	]
	for (const hash of exploreHashes) 
		links.set(hash, {
			nodeHash: hash,
			/**
			 * @param {string} reason 关链原因
			 * @returns {Promise<void>}
			 */
			async close(reason) {
				evicted.push(hash)
				links.delete(hash)
				for (const listener of downListeners) listener(hash, reason)
			},
		})
	

	const registry = {
		localIdentity: SELF,
		/**
		 * @returns {Array<{ nodeHash: string, link: object }>} 当前链路列表
		 */
		listLinks: () => [...links.entries()].map(([nodeHash, link]) => ({ nodeHash, link })),
		/**
		 * @param {string} nodeHash 目标 nodeHash
		 * @returns {object | null} 已有链路或 null
		 */
		getLink: nodeHash => links.get(nodeHash) || null,
		/**
		 * @param {string} nodeHash 目标 nodeHash
		 * @returns {Promise<object>} 模拟建链并触发 link up
		 */
		ensureLinkToNode: async nodeHash => {
			dialed.push(nodeHash)
			const link = {
				nodeHash,
				/**
				 * @param {string} reason 关链原因
				 * @returns {Promise<void>}
				 */
				async close(reason) {
					links.delete(nodeHash)
					for (const listener of downListeners) listener(nodeHash, reason)
				},
			}
			links.set(nodeHash, link)
			return link
		},
		/**
		 * @returns {() => void} 空取消函数
		 */
		onLinkUp: () => () => { },
		/**
		 * @param {(nodeHash: string, reason: string) => void} listener link down 回调
		 * @returns {() => void} 取消订阅
		 */
		onLinkDown: listener => {
			downListeners.add(listener)
			return () => downListeners.delete(listener)
		},
	}

	const ka = createMeshKeepalive({ registry, enabled: true })
	for (const hash of exploreHashes) ka.exploreLinkHashes.add(hash)
	ka.start()
	await new Promise(r => setTimeout(r, 50))
	assertEquals(dialed.includes(PEER.nodeHash), true)
	assertEquals(evicted.length >= 1, true)
	assertEquals(links.has(PEER.nodeHash), true)

	await ka.stop()
	clearDiscoveryProviders()
	await rm(dir, { recursive: true, force: true })
})

test('mesh keepalive: inbound non-trusted marked explore on link up', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'fount-p2p-mesh-in-'))
	await mkdir(dir, { recursive: true })
	initTestP2pNode({ nodeDir: dir })
	clearDiscoveryProviders()

	/** @type {Map<string, object>} */
	const links = new Map()
	/** @type {Set<(nodeHash: string) => void>} */
	const upListeners = new Set()

	const registry = {
		localIdentity: SELF,
		/**
		 * @returns {Array<{ nodeHash: string, link: object }>} 当前链路列表
		 */
		listLinks: () => [...links.entries()].map(([nodeHash, link]) => ({ nodeHash, link })),
		/**
		 * @returns {null} 无已有链路
		 */
		getLink: () => null,
		/**
		 * @returns {Promise<null>} 不拨号
		 */
		ensureLinkToNode: async () => null,
		/**
		 * @param {(nodeHash: string) => void} listener link up 回调
		 * @returns {() => void} 取消订阅
		 */
		onLinkUp: listener => {
			upListeners.add(listener)
			return () => upListeners.delete(listener)
		},
		/**
		 * @returns {() => void} 空取消函数
		 */
		onLinkDown: () => () => { },
	}

	const ka = createMeshKeepalive({ registry, enabled: true })
	ka.start()
	links.set(PEER.nodeHash, { nodeHash: PEER.nodeHash })
	for (const listener of upListeners) listener(PEER.nodeHash)
	assertEquals(ka.exploreLinkHashes.has(PEER.nodeHash), true)

	await ka.stop()
	clearDiscoveryProviders()
	await rm(dir, { recursive: true, force: true })
})
