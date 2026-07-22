import { test } from 'node:test'

import {
	clampPartQueryBudget,
	clampPartQueryTtl,
	measureJsonBytes,
	normalizePartQueryCacheMaterial,
	parsePartQueryReq,
	parsePartQueryRes,
} from '../../schemas/part_query.mjs'
import {
	createPartQueryNodeState,
	handleIncomingPartQueryResponse,
	mergeQueryRows,
	resolvePartQueryHopTimeoutMs,
} from '../../wire/part_query.mjs'
import { createPartQueryCache, partQueryCacheKey } from '../../wire/part_query_cache.mjs'
import { assertEquals } from '../helpers/assert.mjs'

const NODE_A = 'aa'.repeat(32)
const NODE_B = 'bb'.repeat(32)

/**
 * @param {Partial<import('../../schemas/part_query.mjs').PartQueryReq>} patch 覆盖字段
 * @returns {object} 合法 req 骨架
 */
function validReq(patch = {}) {
	return {
		requestId: 'req-1',
		originNodeHash: NODE_A,
		partpath: 'shells/social',
		kind: 'entity_search',
		query: { q: 'alice' },
		ttl: 3,
		budget: { maxHits: 16 },
		...patch,
	}
}

test('parsePartQueryReq rejects missing fields and oversize query', () => {
	assertEquals(parsePartQueryReq(null), null)
	assertEquals(parsePartQueryReq({ ...validReq(), requestId: '' }), null)
	assertEquals(parsePartQueryReq({ ...validReq(), originNodeHash: 'zz' }), null)
	assertEquals(parsePartQueryReq({ ...validReq(), partpath: 'bad:path' }), null)
	assertEquals(parsePartQueryReq({ ...validReq(), kind: '' }), null)
	assertEquals(parsePartQueryReq({ ...validReq(), ttl: 0 }), null)
	const big = 'x'.repeat(3000)
	assertEquals(parsePartQueryReq({ ...validReq(), query: { big } }), null)
	assertEquals(parsePartQueryReq({ ...validReq(), requestId: 'r'.repeat(129) }), null)
	assertEquals(parsePartQueryRes({ requestId: 'r'.repeat(129), fromNodeHash: NODE_B, rows: [] }), null)
})

test('parsePartQueryReq clamps ttl and budget.maxHits', () => {
	const request = parsePartQueryReq(validReq({ ttl: 99, budget: { maxHits: 999 } }))
	assertEquals(request?.ttl, 3)
	assertEquals(request?.budget.maxHits, 32)
})

test('parsePartQueryRes rejects bad rows / node hash', () => {
	assertEquals(parsePartQueryRes({ requestId: 'r', fromNodeHash: NODE_B, rows: 'nope' }), null)
	assertEquals(parsePartQueryRes({ requestId: 'r', fromNodeHash: 'x', rows: [] }), null)
	assertEquals(parsePartQueryRes({ requestId: 'r', fromNodeHash: NODE_B, rows: [{ id: 1 }] })?.rows.length, 1)
})

test('clamp helpers and hop timeouts', () => {
	assertEquals(clampPartQueryTtl(2), 2)
	assertEquals(clampPartQueryTtl(9), 3)
	assertEquals(clampPartQueryBudget({ maxHits: 100 }).maxHits, 32)
	assertEquals(resolvePartQueryHopTimeoutMs(1), 1000)
	assertEquals(resolvePartQueryHopTimeoutMs(2), 2500)
	assertEquals(resolvePartQueryHopTimeoutMs(3), 4000)
	// 发起端取 ttl+1 档，须严格长于第一跳中继的 hopTimeout(maxTtl)
	assertEquals(resolvePartQueryHopTimeoutMs(4) > resolvePartQueryHopTimeoutMs(3), true)
	assertEquals(measureJsonBytes({ a: 1 }) > 0, true)
})

test('duplicate part_query_res from the same peer counts once', () => {
	const state = createPartQueryNodeState()
	state.originBags.set('r1', {
		rows: [],
		maxHits: 8,
		expected: 2,
		received: 0,
		respondedPeers: new Set(),
		/**
		 * @param {{ id: unknown }} row 命中行
		 * @returns {string} 去重键
		 */
		rowKey: row => String(row.id),
	})
	const response = { requestId: 'r1', fromNodeHash: NODE_B, rows: [{ id: 'b' }] }
	handleIncomingPartQueryResponse(response, NODE_B, { state })
	handleIncomingPartQueryResponse({ ...response, rows: [{ id: 'b2' }] }, NODE_B, { state })
	const bag = state.originBags.get('r1')
	assertEquals(bag.received, 1)
	assertEquals(bag.rows.map(row => row.id), ['b'])
})

test('cache key is stable under key order and distinct across kinds', () => {
	const a = partQueryCacheKey('shells/social', 'entity_search', { b: 2, a: 1 })
	const b = partQueryCacheKey('shells/social', 'entity_search', { a: 1, b: 2 })
	const c = partQueryCacheKey('shells/social', 'post_search', { a: 1, b: 2 })
	assertEquals(a, b)
	assertEquals(a === c, false)
	assertEquals(normalizePartQueryCacheMaterial('shells/social', 'entity_search', { a: 1 }) != null, true)
})

test('part query cache TTL and LRU capacity', () => {
	const cache = createPartQueryCache({ maxKeys: 2, ttlMs: 1000, maxHits: 8 })
	let now = 1000
	cache.set('shells/social', 'entity_search', { q: 'a' }, [{ id: 'a' }], now)
	cache.set('shells/social', 'entity_search', { q: 'b' }, [{ id: 'b' }], now)
	cache.set('shells/social', 'entity_search', { q: 'c' }, [{ id: 'c' }], now)
	assertEquals(cache.size, 2)
	assertEquals(cache.get('shells/social', 'entity_search', { q: 'a' }, now), null)
	assertEquals(cache.get('shells/social', 'entity_search', { q: 'c' }, now)?.[0]?.id, 'c')
	now += 1001
	assertEquals(cache.get('shells/social', 'entity_search', { q: 'c' }, now), null)
})

test('mergeQueryRows dedupes by rowKey and respects maxHits', () => {
	const rows = mergeQueryRows([
		[{ id: 'a' }, { id: 'b' }],
		[{ id: 'b' }, { id: 'c' }],
	], 2, row => row.id)
	assertEquals(rows.map(r => r.id), ['a', 'b'])
})
