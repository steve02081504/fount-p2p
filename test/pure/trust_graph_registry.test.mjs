import { test } from 'node:test'

import {
	clearTrustGraphProvider,
	DEFAULT_TRUST_GRAPH_OWNER,
	registerTrustGraphProvider,
	requireTrustGraphProvider,
} from '../../trust_graph/registry.mjs'
import { assertEquals, assertThrows } from '../helpers/assert.mjs'

/**
 * TrustGraph 注册表单元测试（Deno）。
 */


const TEST_USER = '__p2p_trust_graph_test__'

/**
 * 返回空信任图。
 * @returns {Promise<Map<string, never>>} 空信任图
 */
async function buildMergedGraph() {
	return new Map()
}

/**
 * 返回空节点列表。
 * @returns {Promise<never[]>} 无节点
 */
async function pickTopNodes() {
	return []
}

/**
 * 返回发送结果。
 * @returns {Promise<boolean>} 发送结果
 */
async function sendToNode() {
	return false
}

/**
 * 返回扇出数量。
 * @returns {Promise<number>} 扇出次数
 */
async function fanoutToTopNodes() {
	return 0
}

test('trust graph registry register and require', async () => {
	clearTrustGraphProvider()
	assertThrows(() => requireTrustGraphProvider('test'), Error, 'registerTrustGraphProvider')
	registerTrustGraphProvider('test', { buildMergedGraph, pickTopNodes, sendToNode, fanoutToTopNodes })
	assertEquals(await requireTrustGraphProvider('test').fanoutToTopNodes(TEST_USER, 'part_invoke', {}, 1), 0)
	clearTrustGraphProvider()
})

test('default owner id is not chat', () => {
	assertEquals(DEFAULT_TRUST_GRAPH_OWNER, 'default')
})
