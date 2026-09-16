import { test } from 'node:test'

import {
	clearDiscoveryProviders,
	connectToNode,
	prepareConnectToNode,
	registerDiscoveryProvider,
	setDiscoveryLinkDialer,
} from '../../discovery/index.mjs'
import { createLanDiscoveryProvider } from '../../discovery/lan.mjs'
import { noteLanPeerHint, clearLanPeerHints } from '../../discovery/lan_peer_hints.mjs'
import { assertEquals } from '../helpers/assert.mjs'

const REMOTE = 'ab'.repeat(32)

test('connectToNode without dialer only prepares and returns false', async () => {
	clearDiscoveryProviders()
	clearLanPeerHints()
	setDiscoveryLinkDialer(null)
	noteLanPeerHint(REMOTE, { host: '127.0.0.1', port: 18080 })
	registerDiscoveryProvider(createLanDiscoveryProvider())
	assertEquals(await connectToNode(REMOTE), false)
	clearDiscoveryProviders()
	clearLanPeerHints()
})

test('connectToNode with dialer delegates prepare to dialer (no double prepare)', async () => {
	clearDiscoveryProviders()
	clearLanPeerHints()
	noteLanPeerHint(REMOTE, { host: '127.0.0.1', port: 18080 })
	/** @type {string[]} */
	const prepared = []
	registerDiscoveryProvider({
		id: 'prep-probe',
		priority: 1,
		/**
		 * @returns {Promise<string[]>} 空可见列表
		 */
		async listVisibleNodeHashes() { return [] },
		/**
		 * @param {string} nodeHash 目标 nodeHash
		 * @returns {Promise<boolean>} 始终 true（仅记录 prepare）
		 */
		async connectToNode(nodeHash) {
			prepared.push(nodeHash)
			return true
		},
	})
	/** @type {string[]} */
	const dialed = []
	setDiscoveryLinkDialer(async nodeHash => {
		await prepareConnectToNode(nodeHash)
		dialed.push(nodeHash)
		return { ok: true }
	})
	assertEquals(await connectToNode(REMOTE), true)
	assertEquals(prepared, [REMOTE])
	assertEquals(dialed, [REMOTE])
	setDiscoveryLinkDialer(null)
	clearDiscoveryProviders()
	clearLanPeerHints()
})

test('prepareConnectToNode arms lan when hint exists', async () => {
	clearDiscoveryProviders()
	clearLanPeerHints()
	noteLanPeerHint(REMOTE, { host: '10.0.0.2', port: 9 })
	const provider = createLanDiscoveryProvider()
	registerDiscoveryProvider(provider)
	await prepareConnectToNode(REMOTE)
	assertEquals(await provider.connectToNode(REMOTE), true)
	assertEquals(await provider.connectToNode('cd'.repeat(32)), false)
	clearDiscoveryProviders()
	clearLanPeerHints()
})
