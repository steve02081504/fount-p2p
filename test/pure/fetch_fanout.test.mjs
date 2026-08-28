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
			async buildMergedGraph() { return new Map() },
			async sendToNode(_username, nodeHash) { sent.push({ nodeHash }); return true },
			async fanoutToTopNodes(username, action, payload, limit) {
				fanouts.push({ username, action, payload, limit })
				return 0
			},
		},
	}
}

test('fanoutFedFetch with targets sends only to unique valid targets, no node-scope fanout', async () => {
	const dir = await mkTestNodeDir('fount-fetch-fanout-tgt-')
	initTestP2pNode({ nodeDir: dir })
	const mock = createMockTrustGraph()
	registerTrustGraphProvider(DEFAULT_TRUST_GRAPH_OWNER, mock.provider)
	try {
		const a = 'a'.repeat(64)
		const b = 'b'.repeat(64)
		const payload = { requestId: 'r1', nodeHash: 'self' }
		await fanoutFedFetch('u', 'fed_manifest_get', payload, [a, b, b, 'invalid', ''])
		assertEquals(mock.sent.length, 2)
		assertEquals(mock.sent[0].nodeHash, a)
		assertEquals(mock.sent[1].nodeHash, b)
		assertEquals(mock.fanouts.length, 0)
	}
	finally {
		await teardownTestNodeDir(dir)
	}
})

test('fanoutFedFetch without targets keeps node-scope fanoutToTopNodes', async () => {
	const dir = await mkTestNodeDir('fount-fetch-fanout-scope-')
	initTestP2pNode({ nodeDir: dir })
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
		await teardownTestNodeDir(dir)
	}
})
