import { test } from 'node:test'

import { closeNode, initNode } from '../../node/instance.mjs'
import { mkTestNodeDir, teardownTestNodeDir } from '../helpers/node_dir_leak.mjs'
import {
	clearTrustGraphProvider,
	DEFAULT_TRUST_GRAPH_OWNER,
	registerTrustGraphProvider,
} from '../../trust_graph/registry.mjs'
import {
	collectPartInvokeResponses,
	partInvokeDataRows,
	partInvokeErrorMessages,
	PART_INVOKE_FANOUT_DEFAULT,
} from '../../wire/part/fanout.mjs'
import { attachPartWire } from '../../wire/part/ingress.mjs'
import { assert, assertEquals } from '../helpers/assert.mjs'

/**
 * @returns {Promise<string>} 临时 nodeDir
 */
async function createTemporaryNodeDirectory() {
	return mkTestNodeDir('p2p-part-fanout-')
}

/**
 * @returns {{
 *   wire: import('../../wire/adapter.mjs').WireAdapter
 *   handlers: Map<string, Set<Function>>
 *   sent: Array<{ name: string, payload: unknown, peerId: string | null }>
 * }} 内存 wire
 */
function createMemoryWire() {
	/** @type {Map<string, Set<Function>>} */
	const handlers = new Map()
	/** @type {Array<{ name: string, payload: unknown, peerId: string | null }>} */
	const sent = []
	return {
		handlers,
		sent,
		wire: {
			/**
			 * @param {string} name action 名
			 * @param {Function} handler 回调
			 * @returns {() => void} 取消订阅
			 */
			on(name, handler) {
				if (!handlers.has(name)) handlers.set(name, new Set())
				handlers.get(name).add(handler)
				return () => handlers.get(name)?.delete(handler)
			},
			/**
			 * @param {string} name action 名
			 * @param {unknown} payload 载荷
			 * @param {string | null} peerId 目标 peer
			 * @returns {void}
			 */
			send(name, payload, peerId) {
				sent.push({ name, payload, peerId })
			},
		},
	}
}

/**
 * @param {Map<string, Set<Function>>} handlers wire handlers
 * @param {string} name action
 * @param {unknown} payload 载荷
 * @param {string} peerId 对端
 * @returns {void}
 */
function dispatch(handlers, name, payload, peerId) {
	for (const handler of handlers.get(name) || [])
		handler(payload, peerId)
}

test('collectPartInvokeResponses gathers neighbor replies until maxResponses', async () => {
	const nodeDir = await createTemporaryNodeDirectory()
	closeNode()
	clearTrustGraphProvider()
	initNode({ nodeDir })
	const { wire, handlers } = createMemoryWire()
	attachPartWire({ replicaUsername: 'alice' }, wire)

	/** @type {object[]} */
	const fanouts = []
	registerTrustGraphProvider(DEFAULT_TRUST_GRAPH_OWNER, {
		/**
		 * @returns {Promise<Map<string, never>>} 空信任图
		 */
		async buildMergedGraph() { return new Map() },
		/**
		 * @returns {Promise<never[]>} 无节点
		 */
		pickTopNodes() { return [] },
		/**
		 * @returns {Promise<boolean>} 发送结果
		 */
		async sendToNode() { return false },
		/**
		 * @param {string} username 副本用户名
		 * @param {string} action action 名
		 * @param {unknown} payload 载荷
		 * @param {number} limit 扇出上限
		 * @returns {Promise<number>} 扇出次数
		 */
		async fanoutToTopNodes(username, action, payload, limit) {
			fanouts.push({ username, action, payload, limit })
			queueMicrotask(() => {
				dispatch(handlers, 'part_invoke_response', {
					requestId: payload.requestId,
					partpath: payload.partpath,
					response: { result: { from: 'peer-a' } },
				}, 'peer-a')
				dispatch(handlers, 'part_invoke_response', {
					requestId: payload.requestId,
					partpath: payload.partpath,
					response: { result: { from: 'peer-b' } },
				}, 'peer-b')
			})
			return 2
		},
	})

	try {
		const replies = await collectPartInvokeResponses(
			'alice',
			'shells/social',
			{ kind: 'ping' },
			1000,
			2,
		)
		assertEquals(fanouts.length, 1)
		assertEquals(fanouts[0].action, 'part_invoke')
		assertEquals(fanouts[0].limit, 2)
		assert.ok(fanouts[0].payload.requestId)
		assertEquals(replies.length, 2)
		assertEquals(partInvokeDataRows(replies), [{ from: 'peer-a' }, { from: 'peer-b' }])
		assertEquals(partInvokeErrorMessages(replies), [])
	}
	finally {
		clearTrustGraphProvider()
		closeNode()
		await teardownTestNodeDir(nodeDir)
	}
})

test('collectPartInvokeResponses finishes immediately when fanout sends zero', async () => {
	const nodeDir = await createTemporaryNodeDirectory()
	closeNode()
	clearTrustGraphProvider()
	initNode({ nodeDir })
	attachPartWire({ replicaUsername: 'alice' }, createMemoryWire().wire)

	registerTrustGraphProvider(DEFAULT_TRUST_GRAPH_OWNER, {
		/**
		 * @returns {Promise<Map<string, never>>} 空信任图
		 */
		async buildMergedGraph() { return new Map() },
		/**
		 * @returns {Promise<never[]>} 无节点
		 */
		pickTopNodes() { return [] },
		/**
		 * @returns {Promise<boolean>} 发送结果
		 */
		async sendToNode() { return false },
		/**
		 * @returns {Promise<number>} 扇出次数
		 */
		async fanoutToTopNodes() { return 0 },
	})

	try {
		const replies = await collectPartInvokeResponses(
			'alice',
			'shells/cabinet',
			{ kind: 'cabinet_operation_pull', cabinetId: 'c1', haveOperationIds: [] },
			5000,
			PART_INVOKE_FANOUT_DEFAULT,
		)
		assertEquals(replies, [])
	}
	finally {
		clearTrustGraphProvider()
		closeNode()
		await teardownTestNodeDir(nodeDir)
	}
})

test('collectPartInvokeResponses respects timeoutMs even when fanout hangs', async () => {
	const nodeDir = await createTemporaryNodeDirectory()
	closeNode()
	clearTrustGraphProvider()
	initNode({ nodeDir })
	attachPartWire({ replicaUsername: 'alice' }, createMemoryWire().wire)

	registerTrustGraphProvider(DEFAULT_TRUST_GRAPH_OWNER, {
		/**
		 * @returns {Promise<Map<string, never>>} 空信任图
		 */
		async buildMergedGraph() { return new Map() },
		/**
		 * @returns {Promise<never[]>} 无节点
		 */
		pickTopNodes() { return [] },
		/**
		 * @returns {Promise<boolean>} 发送结果
		 */
		async sendToNode() { return false },
		/**
		 * @returns {Promise<number>} 永不 settle（模拟 discoverRoute / stuck send）
		 */
		async fanoutToTopNodes() {
			await new Promise(() => { /* hang */ })
			return 0
		},
	})

	try {
		const started = Date.now()
		const collectPromise = collectPartInvokeResponses(
			'alice',
			'shells/social',
			{ kind: 'list_available_emoji_packs' },
			80,
			2,
		)
		// 外层哨兵：bug 复现时 collect 永不 settle，不能直接 await
		const outcome = await Promise.race([
			collectPromise.then(replies => ({ kind: 'settled', replies, elapsed: Date.now() - started })),
			new Promise(resolve => setTimeout(() => resolve({ kind: 'hung' }), 500)),
		])
		assertEquals(outcome.kind, 'settled')
		assertEquals(outcome.replies, [])
		assert.ok(outcome.elapsed < 500, `expected end-to-end bound by timeoutMs, took ${outcome.elapsed}ms`)
	}
	finally {
		clearTrustGraphProvider()
		closeNode()
		await teardownTestNodeDir(nodeDir)
	}
})

test('partInvokeDataRows / partInvokeErrorMessages split result and error', () => {
	const rows = partInvokeDataRows([
		{ result: { ok: 1 } },
		{ error: { message: 'nope', code: 'NOPE' } },
		{ result: { ok: 2 } },
	])
	assertEquals(rows, [{ ok: 1 }, { ok: 2 }])
	assertEquals(partInvokeErrorMessages([
		{ result: { ok: 1 } },
		{ error: { message: 'nope', code: 'NOPE' } },
	]), ['nope'])
})
