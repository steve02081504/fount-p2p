import { test } from 'node:test'

import {
	attachPartQueryWire,
	createPartQueryNodeState,
	queryNetwork,
	registerQueryInboundHandler,
	resetPartQueryStateForTests,
} from '../../wire/part_query.mjs'
import { createPartQueryCache } from '../../wire/part_query_cache.mjs'
import { assert, assertEquals } from '../helpers/assert.mjs'

const NODE_A = 'aa'.repeat(32)
const NODE_B = 'bb'.repeat(32)
const NODE_C = 'cc'.repeat(32)

/**
 * 内存多节点假 link：deliver 按拓扑投递 part_query_*。
 * @param {Record<string, string[]>} topology nodeHash → 邻居
 * @param {(nodeHash: string) => unknown[]} localRowsFor 各节点本地命中
 * @returns {{
 *   nodes: Map<string, object>
 *   forwardCounts: Map<string, number>
 *   queryFrom: (origin: string, opts?: object) => Promise<unknown[]>
 * }} 测试网
 */
function createFakeQueryNet(topology, localRowsFor) {
	/** @type {Map<string, { state: ReturnType<typeof createPartQueryNodeState>, deps: object, handlers: Map<string, Set<Function>>, forwardCount: number }>} */
	const nodes = new Map()
	const forwardCounts = new Map()

	for (const nodeHash of Object.keys(topology)) {
		const state = createPartQueryNodeState({ cache: createPartQueryCache({ ttlMs: 60_000 }) })
		registerQueryInboundHandler('shells/social', 'entity_search', () => localRowsFor(nodeHash), state)
		/** @type {Map<string, Set<Function>>} */
		const handlers = new Map()
		const wire = {
			/**
			 * @param {string} name action
			 * @param {Function} handler 回调
			 * @returns {void}
			 */
			on(name, handler) {
				if (!handlers.has(name)) handlers.set(name, new Set())
				handlers.get(name).add(handler)
			},
			/**
			 * @param {string} name action
			 * @param {unknown} payload 载荷
			 * @param {string | null} peerId 目标
			 * @returns {void}
			 */
			send(name, payload, peerId) {
				if (!peerId) return
				const target = nodes.get(peerId)
				if (!target) return
				const set = target.handlers.get(name)
				if (!set) return
				for (const handler of set) handler(payload, nodeHash)
			},
		}
		const deps = {
			state,
			/**
			 * @returns {string} 本节点 hash
			 */
			getNodeHash: () => nodeHash,
			/**
			 * @param {Set<string>} exclude 已触达节点
			 * @returns {Promise<string[]>} 可转发邻居
			 */
			selectNeighbors: async exclude => (topology[nodeHash] || []).filter(n => !exclude.has(n)),
			/**
			 * @param {string} target 目标 nodeHash
			 * @param {string} action wire action
			 * @param {unknown} payload 帧体
			 * @returns {Promise<boolean>} 是否投递成功
			 */
			deliver: async (target, action, payload) => {
				forwardCounts.set(nodeHash, (forwardCounts.get(nodeHash) || 0) + 1)
				const peer = nodes.get(target)
				if (!peer) return false
				const set = peer.handlers.get(action)
				if (!set) return false
				for (const handler of set) handler(payload, nodeHash)
				return true
			},
		}
		attachPartQueryWire({ replicaUsername: 'alice' }, wire, deps)
		nodes.set(nodeHash, { state, deps, handlers, wire })
	}

	return {
		nodes,
		forwardCounts,
		/**
		 * @param {string} origin 发起节点
		 * @param {object} [opts] queryNetwork 选项
		 * @returns {Promise<unknown[]>} rows
		 */
		queryFrom(origin, opts = {}) {
			const node = nodes.get(origin)
			assert(node, 'origin missing')
			return queryNetwork('alice', 'shells/social', 'entity_search', { q: 'alice' }, {
				...node.deps,
				ttl: 2,
				timeoutMs: 200,
				/**
				 * @param {{ id: unknown }} row 命中行
				 * @returns {string} 去重键
				 */
				rowKey: row => String(row.id),
				...opts,
			})
		},
	}
}

test('one-hop answer aggregates local + neighbor rows', async () => {
	resetPartQueryStateForTests()
	const net = createFakeQueryNet({
		[NODE_A]: [NODE_B],
		[NODE_B]: [NODE_A],
	}, hash => {
		if (hash === NODE_A) return [{ id: 'a-local' }]
		if (hash === NODE_B) return [{ id: 'b-hit' }]
		return []
	})
	const rows = await net.queryFrom(NODE_A, { ttl: 1 })
	assertEquals(rows.map(r => r.id).sort(), ['a-local', 'b-hit'])
})

test('two-hop forward aggregates reverse-path rows', async () => {
	resetPartQueryStateForTests()
	const net = createFakeQueryNet({
		[NODE_A]: [NODE_B],
		[NODE_B]: [NODE_A, NODE_C],
		[NODE_C]: [NODE_B],
	}, hash => {
		if (hash === NODE_A) return [{ id: 'a' }]
		if (hash === NODE_B) return [{ id: 'b' }]
		if (hash === NODE_C) return [{ id: 'c' }]
		return []
	})
	const rows = await net.queryFrom(NODE_A, { ttl: 2, timeoutMs: 500 })
	assertEquals(rows.map(r => r.id).sort(), ['a', 'b', 'c'])
	assertEquals((net.forwardCounts.get(NODE_A) || 0) >= 1, true)
	assertEquals((net.forwardCounts.get(NODE_B) || 0) >= 1, true)
})

test('duplicate requestId is dropped on ingress', async () => {
	resetPartQueryStateForTests()
	const net = createFakeQueryNet({
		[NODE_A]: [NODE_B],
		[NODE_B]: [NODE_A],
	}, hash => hash === NODE_B ? [{ id: 'b' }] : [])

	const nodeB = net.nodes.get(NODE_B)
	let handlerCalls = 0
	registerQueryInboundHandler('shells/social', 'entity_search', () => {
		handlerCalls += 1
		return [{ id: 'b' }]
	}, nodeB.state)

	const req = {
		requestId: 'dup-req-1',
		originNodeHash: NODE_A,
		partpath: 'shells/social',
		kind: 'entity_search',
		query: { q: 'x' },
		ttl: 1,
		budget: { maxHits: 8 },
	}
	const handlers = nodeB.handlers.get('part_query_req')
	for (const handler of handlers) {
		handler(req, NODE_A)
		handler(req, NODE_A)
	}
	await new Promise(resolve => setTimeout(resolve, 20))
	assertEquals(handlerCalls, 1)
})

test('cache hit skips forward; expiry resumes forward', async () => {
	resetPartQueryStateForTests()
	let now = 1_000_000
	const cache = createPartQueryCache({ ttlMs: 1000, maxKeys: 16 })
	const topology = {
		[NODE_A]: [NODE_B],
		[NODE_B]: [NODE_A],
	}
	/** @type {Map<string, object>} */
	const nodes = new Map()
	const forwardCounts = new Map()

	for (const nodeHash of Object.keys(topology)) {
		const state = createPartQueryNodeState({ cache: nodeHash === NODE_A ? cache : createPartQueryCache() })
		registerQueryInboundHandler('shells/social', 'entity_search', () => 
			nodeHash === NODE_B ? [{ id: 'b' }] : [{ id: 'a' }]
		, state)
		/** @type {Map<string, Set<Function>>} */
		const handlers = new Map()
		const deps = {
			state,
			/**
			 * @returns {number} 可控时钟（毫秒）
			 */
			now: () => now,
			/**
			 * @returns {string} 本节点 hash
			 */
			getNodeHash: () => nodeHash,
			/**
			 * @param {Set<string>} exclude 已触达节点
			 * @returns {Promise<string[]>} 可转发邻居
			 */
			selectNeighbors: async exclude => topology[nodeHash].filter(n => !exclude.has(n)),
			/**
			 * @param {string} target 目标 nodeHash
			 * @param {string} action wire action
			 * @param {unknown} payload 帧体
			 * @returns {Promise<boolean>} 是否投递成功
			 */
			deliver: async (target, action, payload) => {
				forwardCounts.set(nodeHash, (forwardCounts.get(nodeHash) || 0) + 1)
				const peer = nodes.get(target)
				for (const handler of peer.handlers.get(action) || []) handler(payload, nodeHash)
				return true
			},
		}
		const wire = {
			/**
			 * @param {string} name action
			 * @param {Function} handler 回调
			 * @returns {void}
			 */
			on(name, handler) {
				if (!handlers.has(name)) handlers.set(name, new Set())
				handlers.get(name).add(handler)
			},
			/**
			 * @param {string} name action
			 * @param {unknown} payload 载荷
			 * @param {string | null} peerId 目标
			 * @returns {void}
			 */
			send(name, payload, peerId) {
				const peer = nodes.get(peerId)
				for (const handler of peer?.handlers.get(name) || []) handler(payload, nodeHash)
			},
		}
		attachPartQueryWire({ replicaUsername: 'alice' }, wire, deps)
		nodes.set(nodeHash, { state, deps, handlers })
	}

	/**
	 * @param {{ id: string }} row 命中行
	 * @returns {string} 去重键
	 */
	const rowKey = row => row.id
	const origin = nodes.get(NODE_A)
	const first = await queryNetwork('alice', 'shells/social', 'entity_search', { q: 'hot' }, {
		...origin.deps,
		ttl: 1,
		timeoutMs: 200,
		rowKey,
	})
	assertEquals(first.map(r => r.id).sort(), ['a', 'b'])
	const forwardsAfterFirst = forwardCounts.get(NODE_A) || 0
	assertEquals(forwardsAfterFirst >= 1, true)

	const second = await queryNetwork('alice', 'shells/social', 'entity_search', { q: 'hot' }, {
		...origin.deps,
		ttl: 1,
		timeoutMs: 200,
		rowKey,
	})
	assertEquals(second.map(r => r.id).sort(), ['a', 'b'])
	assertEquals(forwardCounts.get(NODE_A) || 0, forwardsAfterFirst)

	now += 1001
	const third = await queryNetwork('alice', 'shells/social', 'entity_search', { q: 'hot' }, {
		...origin.deps,
		ttl: 1,
		timeoutMs: 200,
		rowKey,
	})
	assertEquals(third.map(r => r.id).sort(), ['a', 'b'])
	assertEquals((forwardCounts.get(NODE_A) || 0) > forwardsAfterFirst, true)
})

test('origin cache hit does not broadcast; relay cache hit does not forward further', async () => {
	resetPartQueryStateForTests()
	const net = createFakeQueryNet({
		[NODE_A]: [NODE_B],
		[NODE_B]: [NODE_A, NODE_C],
		[NODE_C]: [NODE_B],
	}, hash => {
		if (hash === NODE_C) return [{ id: 'c' }]
		if (hash === NODE_B) return [{ id: 'b' }]
		return [{ id: 'a' }]
	})

	await net.queryFrom(NODE_A, { ttl: 2, timeoutMs: 500 })
	assertEquals((net.forwardCounts.get(NODE_B) || 0) >= 1, true)

	// 发起端缓存命中：不广播
	net.forwardCounts.set(NODE_A, 0)
	net.forwardCounts.set(NODE_B, 0)
	await net.queryFrom(NODE_A, { ttl: 2, timeoutMs: 500 })
	assertEquals(net.forwardCounts.get(NODE_A) || 0, 0)
	assertEquals(net.forwardCounts.get(NODE_B) || 0, 0)

	// 清掉 A 缓存，保留 B：A 会转发，B 缓存命中后不再向 C 转发
	net.nodes.get(NODE_A).state.cache.clear()
	net.forwardCounts.set(NODE_A, 0)
	net.forwardCounts.set(NODE_B, 0)
	const rows = await net.queryFrom(NODE_A, { ttl: 2, timeoutMs: 500 })
	assertEquals(rows.map(r => r.id).sort(), ['a', 'b', 'c'])
	assertEquals(net.forwardCounts.get(NODE_A) || 0, 1)
	assertEquals(net.forwardCounts.get(NODE_B) || 0, 0)
})
