import { test } from 'node:test'

import { fanoutFedFetch } from '../../files/fetch_fanout.mjs'
import {
	DEFAULT_TRUST_GRAPH_OWNER,
	registerTrustGraphProvider,
} from '../../trust_graph/registry.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { initTestP2pNode } from '../helpers/node.mjs'
import { mkTestNodeDir, teardownTestNodeDir } from '../helpers/node_dir_leak.mjs'

/**
 * @returns {{
 *   provider: {
 *     buildMergedGraph: () => Promise<Map<string, object>>,
 *     sendToNode: (username: string, nodeHash: string, action: string, payload: object) => Promise<boolean>,
 *     fanoutToTopNodes: (username: string, action: string, payload: object, limit: number) => Promise<number>,
 *   },
 *   sent: Array<{ nodeHash: string }>,
 *   fanouts: Array<{ username: string, action: string, payload: object, limit: number }>,
 * }} mock trust graph provider
 */
function createMockTrustGraph() {
	/** @type {Array<{ nodeHash: string }>} */
	const sent = []
	/** @type {Array<{ username: string, action: string, payload: object, limit: number }>} */
	const fanouts = []
	return {
		sent,
		fanouts,
		provider: {
			/**
			 * @returns {Promise<Map<string, object>>} 空信任图
			 */
			async buildMergedGraph() { return new Map() },
			/**
			 * @param {string} username 用户名（占位未使用）
			 * @param {string} nodeHash 目标 nodeHash
			 * @returns {Promise<boolean>} 是否发送成功
			 */
			async sendToNode(username, nodeHash) { sent.push({ nodeHash }); return true },
			/**
			 * @param {string} username 用户名
			 * @param {string} action 动作名
			 * @param {object} payload 负载
			 * @param {number} limit 扇出上限
			 * @returns {Promise<number>} 扇出数量
			 */
			async fanoutToTopNodes(username, action, payload, limit) {
				fanouts.push({ username, action, payload, limit })
				return 0
			},
		},
	}
}

test('fanoutFedFetch with targets sends only to unique valid targets, no node-scope fanout', async () => {
	const nodeDirectory = await mkTestNodeDir('fount-fetch-fanout-tgt-')
	initTestP2pNode({ nodeDir: nodeDirectory })
	const mock = createMockTrustGraph()
	registerTrustGraphProvider(DEFAULT_TRUST_GRAPH_OWNER, mock.provider)
	try {
		const firstTargetNodeHash = 'a'.repeat(64)
		const secondTargetNodeHash = 'b'.repeat(64)
		const payload = { requestId: 'r1', nodeHash: 'self' }
		await fanoutFedFetch('u', 'fed_manifest_get', payload, [firstTargetNodeHash, secondTargetNodeHash, secondTargetNodeHash, 'invalid', ''])
		assertEquals(mock.sent.length, 2)
		assertEquals(mock.sent[0].nodeHash, firstTargetNodeHash)
		assertEquals(mock.sent[1].nodeHash, secondTargetNodeHash)
		assertEquals(mock.fanouts.length, 0)
	}
	finally {
		await teardownTestNodeDir(nodeDirectory)
	}
})

test('fanoutFedFetch without targets keeps node-scope fanoutToTopNodes', async () => {
	const nodeDirectory = await mkTestNodeDir('fount-fetch-fanout-scope-')
	initTestP2pNode({ nodeDir: nodeDirectory })
	const mock = createMockTrustGraph()
	registerTrustGraphProvider(DEFAULT_TRUST_GRAPH_OWNER, mock.provider)
	try {
		const payload = { requestId: 'r2', nodeHash: 'self' }
		await fanoutFedFetch('u', 'fed_manifest_get', payload)
		assertEquals(mock.fanouts.length, 1)
		assertEquals(mock.fanouts[0].action, 'fed_manifest_get')
		assertEquals(mock.fanouts[0].payload.requestId, 'r2')
	}
	finally {
		await teardownTestNodeDir(nodeDirectory)
	}
})

test('fanoutFedFetch with invalid-only targets sends nothing, no node-scope fanout', async () => {
	const nodeDirectory = await mkTestNodeDir('fount-fetch-fanout-invalid-')
	initTestP2pNode({ nodeDir: nodeDirectory })
	const mock = createMockTrustGraph()
	registerTrustGraphProvider(DEFAULT_TRUST_GRAPH_OWNER, mock.provider)
	try {
		const payload = { requestId: 'r3', nodeHash: 'self' }
		await fanoutFedFetch('u', 'fed_manifest_get', payload, ['not-hex', '', '0x' + 'a'.repeat(64)])
		assertEquals(mock.sent.length, 0)
		assertEquals(mock.fanouts.length, 0)
	}
	finally {
		await teardownTestNodeDir(nodeDirectory)
	}
})
