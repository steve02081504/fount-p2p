import { randomUUID } from 'node:crypto'

import { createDedupeSlot } from '../federation/dedupe_slot.mjs'
import { getNodeHash } from '../node/identity.mjs'
import { loadReputation } from '../node/reputation_store.mjs'
import { isQuarantinedPure } from '../reputation/engine.mjs'
import {
	clampPartQueryRows,
	parsePartQueryReq,
	parsePartQueryRes,
} from '../schemas/part_query.mjs'
import { buildMergedGraph } from '../trust_graph/build.mjs'
import { pickTopFromGraph } from '../trust_graph/engine.mjs'
import { DEFAULT_TRUST_GRAPH_OWNER, requireTrustGraphProvider } from '../trust_graph/registry.mjs'
import { resolveFederationFanoutTopK } from '../trust_graph/resolve.mjs'
import trustGraphTunables from '../trust_graph/tunables.json' with { type: 'json' }

import { isPlainObject } from './ingress.mjs'
import partQueryTunables from './part_query.tunables.json' with { type: 'json' }
import { createPartQueryCache, partQueryCache } from './part_query_cache.mjs'
import { consumeWireRateBucket } from './rate_bucket.mjs'
import { finishMultiWireWaiters, registerMultiWireWait } from './wait.mjs'

/** @typedef {import('../schemas/part_query.mjs').PartQueryReq} PartQueryReq */
/** @typedef {import('../schemas/part_query.mjs').PartQueryRes} PartQueryRes */
/** @typedef {import('./part_ingress.mjs').PartWireAdapter} PartWireAdapter */

/**
 * @typedef {{
 *   replicaUsername?: string
 *   peerId?: string
 *   requesterNodeHash?: string | null
 * }} QueryInboundContext
 */

/**
 * @typedef {(queryContext: QueryInboundContext, query: unknown) => Promise<unknown[] | null | undefined> | unknown[] | null | undefined} QueryInboundHandler
 */

/**
 * @typedef {{
 *   takeDedupe: (key: string) => boolean
 *   relayPending: Map<string, RelayPending>
 *   originWaits: Map<string, Map<string, import('./wait.mjs').WireWaiter[]>>
 *   originBags: Map<string, { rows: unknown[], maxHits: number, expected: number, received: number, respondedPeers: Set<string>, rowKey?: (row: unknown) => string }>
 *   cache: ReturnType<typeof createPartQueryCache>
 *   handlers: Map<string, QueryInboundHandler>
 * }} PartQueryNodeState
 */

/**
 * @typedef {{
 *   selectNeighbors?: (exclude: Set<string>) => Promise<string[]>
 *   deliver?: (nodeHash: string, action: string, payload: unknown) => Promise<boolean> | boolean
 *   getNodeHash?: () => string
 *   now?: () => number
 *   state?: PartQueryNodeState
 * }} PartQueryDependencies
 */

/**
 * @typedef {{
 *   upstreamPeerId: string
 *   wire: PartWireAdapter
 *   request: PartQueryReq
 *   localRows: unknown[]
 *   remoteRows: unknown[]
 *   expected: number
 *   received: number
 *   respondedPeers: Set<string>
 *   flushed: boolean
 *   timer: ReturnType<typeof setTimeout> | null
 *   dependencies: PartQueryDependencies
 *   state: PartQueryNodeState
 * }} RelayPending
 */

/**
 * @param {{ cache?: ReturnType<typeof createPartQueryCache> }} [options] 选项
 * @returns {PartQueryNodeState} 单节点运行时状态
 */
export function createPartQueryNodeState(options = {}) {
	return {
		takeDedupe: createDedupeSlot({
			maxSize: partQueryTunables.dedupeMaxSize,
			ttlMs: partQueryTunables.dedupeTtlMs,
		}),
		relayPending: new Map(),
		originWaits: new Map(),
		originBags: new Map(),
		cache: options.cache || createPartQueryCache(),
		handlers: new Map(),
	}
}

/** 本进程默认单节点状态 */
const defaultState = createPartQueryNodeState({ cache: partQueryCache })

/**
 * @param {PartQueryDependencies} [dependencies] 依赖
 * @returns {PartQueryNodeState} 节点状态
 */
function resolveState(dependencies = {}) {
	return dependencies.state || defaultState
}

/**
 * @param {string} partpath part 路径
 * @param {string} kind 查询标签
 * @returns {string} handler 键
 */
function handlerKey(partpath, kind) {
	return `${partpath}\0${kind}`
}

/**
 * Shell 注册 kind 语义处理器（怎么匹配、返回什么）。
 * @param {string} partpath part 路径
 * @param {string} kind 查询标签（如 entity_search）
 * @param {QueryInboundHandler} handler 本地匹配器
 * @param {PartQueryNodeState} [state] 节点状态（默认本机）
 * @returns {void}
 */
export function registerQueryInboundHandler(partpath, kind, handler, state = defaultState) {
	state.handlers.set(handlerKey(String(partpath || '').trim(), String(kind || '').trim()), handler)
}

/**
 * ttl 越大等得越久；发起端用 `ttl + 1` 取值，保证严格长于第一跳中继的 flush 超时。
 * @param {number} ttl 当前节点剩余 ttl
 * @param {typeof partQueryTunables} [tunables] 可调
 * @returns {number} 等待下游超时
 */
export function resolvePartQueryHopTimeoutMs(ttl, tunables = partQueryTunables) {
	const table = tunables.hopTimeoutMs || [1000, 2500, 4000, 6000]
	const index = Math.max(0, Math.min(table.length - 1, Math.floor(ttl) - 1))
	return Math.max(1, Math.floor(Number(table[index]) || tunables.defaultTimeoutMs || 4000))
}

/**
 * @param {unknown[]} lists 多路 rows
 * @param {number} maxHits 上限
 * @param {(row: unknown) => string} [rowKey] 去重键
 * @returns {unknown[]} 合并去重后的 rows
 */
export function mergeQueryRows(lists, maxHits, rowKey) {
	const out = []
	const seen = new Set()
	const keyOf = typeof rowKey === 'function'
		? rowKey
		: row => {
			try { return JSON.stringify(row) }
			catch { return `\0${out.length}` }
		}
	for (const list of lists) {
		if (!Array.isArray(list)) continue
		for (const row of list) {
			const key = keyOf(row)
			if (seen.has(key)) continue
			seen.add(key)
			out.push(row)
			if (out.length >= maxHits) return out
		}
	}
	return out
}

/**
 * @param {PartQueryNodeState} state 节点状态
 * @param {QueryInboundContext} queryContext 入站上下文
 * @param {string} partpath part 路径
 * @param {string} kind 查询标签
 * @param {unknown} query 查询体
 * @returns {Promise<unknown[]>} 本地 rows
 */
async function runLocalHandler(state, queryContext, partpath, kind, query) {
	const handler = state.handlers.get(handlerKey(partpath, kind))
	if (!handler) return []
	return await handler(queryContext, query) || []
}

/**
 * @param {string} username trust graph 上下文
 * @param {Set<string>} exclude 排除节点
 * @param {PartQueryDependencies} dependencies 可注入依赖
 * @returns {Promise<string[]>} 邻居 nodeHash
 */
async function selectQueryNeighbors(username, exclude, dependencies) {
	if (dependencies.selectNeighbors) return dependencies.selectNeighbors(exclude)
	const graph = await buildMergedGraph(username)
	const fanoutCap = Math.max(1, Math.floor(Number(partQueryTunables.fanoutCap) || 4))
	const k = Math.min(fanoutCap, resolveFederationFanoutTopK(graph.size, trustGraphTunables))
	const rep = loadReputation()
	const quarantined = new Set(
		Object.keys(rep.byNodeHash || {}).filter(id => isQuarantinedPure(rep, id)),
	)
	const oversample = Math.min(graph.size, k + exclude.size + 2)
	return pickTopFromGraph(graph, oversample, trustGraphTunables, quarantined)
		.map(node => node.nodeHash)
		.filter(hash => !exclude.has(hash))
		.slice(0, k)
}

/**
 * @param {string} username 用户
 * @param {string} nodeHash 目标
 * @param {string} action action 名
 * @param {unknown} payload 载荷
 * @param {PartQueryDependencies} dependencies 依赖
 * @returns {Promise<boolean>} 是否发出
 */
async function deliverQuery(username, nodeHash, action, payload, dependencies) {
	if (dependencies.deliver) return Boolean(await dependencies.deliver(nodeHash, action, payload))
	return requireTrustGraphProvider(DEFAULT_TRUST_GRAPH_OWNER).sendToNode(username, nodeHash, action, payload)
}

/**
 * @param {PartQueryReq} request 请求
 * @param {unknown[]} rows 行
 * @param {() => string} nodeHashOf 本机 hash
 * @returns {PartQueryRes} 响应载荷
 */
function buildResponse(request, rows, nodeHashOf) {
	const capped = clampPartQueryRows(rows, request.budget.maxHits) || []
	return {
		requestId: request.requestId,
		fromNodeHash: nodeHashOf(),
		rows: capped,
	}
}

/**
 * @param {RelayPending} pending 中继槽
 * @returns {void}
 */
function flushRelayPending(pending) {
	if (pending.flushed) return
	pending.flushed = true
	if (pending.timer) {
		clearTimeout(pending.timer)
		pending.timer = null
	}
	pending.state.relayPending.delete(pending.request.requestId)
	const merged = mergeQueryRows([pending.localRows, pending.remoteRows], pending.request.budget.maxHits)
	const now = pending.dependencies.now || Date.now
	pending.state.cache.set(pending.request.partpath, pending.request.kind, pending.request.query, merged, now())
	const nodeHashOf = pending.dependencies.getNodeHash || getNodeHash
	try {
		pending.wire.send('part_query_res', buildResponse(pending.request, merged, nodeHashOf), pending.upstreamPeerId)
	}
	catch { /* disconnected */ }
}

/**
 * @param {{ replicaUsername?: string }} wireContext attach 上下文
 * @param {PartWireAdapter} wire wire
 * @param {PartQueryReq} request 已校验请求
 * @param {string} peerId 来路
 * @param {PartQueryDependencies} dependencies 依赖
 * @returns {Promise<void>}
 */
async function processIncomingRequest(wireContext, wire, request, peerId, dependencies) {
	const state = resolveState(dependencies)
	const nodeHashOf = dependencies.getNodeHash || getNodeHash
	const now = dependencies.now || Date.now
	const username = String(wireContext.replicaUsername || '')

	const cached = state.cache.get(request.partpath, request.kind, request.query, now())
	if (cached) {
		try { wire.send('part_query_res', buildResponse(request, cached, nodeHashOf), peerId) }
		catch { /* disconnected */ }
		return
	}

	const localRows = await runLocalHandler(state, {
		replicaUsername: wireContext.replicaUsername,
		requesterNodeHash: request.originNodeHash,
		peerId,
	}, request.partpath, request.kind, request.query)

	const nextTtl = request.ttl - 1
	if (nextTtl <= 0) {
		state.cache.set(request.partpath, request.kind, request.query, localRows, now())
		try { wire.send('part_query_res', buildResponse(request, localRows, nodeHashOf), peerId) }
		catch { /* disconnected */ }
		return
	}

	const selfHash = nodeHashOf()
	const exclude = new Set([selfHash, request.originNodeHash, String(peerId || '').trim().toLowerCase()].filter(Boolean))
	const neighbors = username ? await selectQueryNeighbors(username, exclude, dependencies) : []
	const forwardPayload = { ...request, ttl: nextTtl }

	/** @type {RelayPending} */
	const pending = {
		upstreamPeerId: peerId,
		wire,
		request,
		localRows,
		remoteRows: [],
		expected: 0,
		received: 0,
		respondedPeers: new Set(),
		flushed: false,
		timer: null,
		dependencies,
		state,
	}
	state.relayPending.set(request.requestId, pending)

	let sent = 0
	for (const target of neighbors)
		if (await deliverQuery(username, target, 'part_query_req', forwardPayload, dependencies)) sent++
	pending.expected = sent

	if (sent === 0 || pending.received >= pending.expected) {
		flushRelayPending(pending)
		return
	}

	pending.timer = setTimeout(() => flushRelayPending(pending), resolvePartQueryHopTimeoutMs(request.ttl))
}

/**
 * 挂载 part_query_req / part_query_res。
 * @param {{ replicaUsername?: string }} wireContext 入站上下文
 * @param {PartWireAdapter} wire wire
 * @param {PartQueryDependencies} [dependencies] 可注入依赖（含 per-node state）
 * @returns {void}
 */
export function attachPartQueryWire(wireContext, wire, dependencies = {}) {
	const state = resolveState(dependencies)
	wire.on('part_query_req', (data, peerId) => {
		if (!isPlainObject(data)) return
		const request = parsePartQueryReq(data)
		if (!request) return
		if (!state.takeDedupe(request.requestId)) return
		const source = String(peerId || request.originNodeHash || '').trim().toLowerCase()
		if (source && !consumeWireRateBucket(`part_query:${source}`, {
			maxCount: partQueryTunables.ratePerSourcePerMin,
		})) return
		void processIncomingRequest(wireContext, wire, request, String(peerId || ''), dependencies)
	})

	wire.on('part_query_res', (data, peerId) => {
		const response = parsePartQueryRes(data)
		if (!response) return
		handleIncomingPartQueryResponse(response, String(peerId || ''), dependencies)
	})
}

/**
 * @param {PartQueryRes} response 响应
 * @param {string} peerId 来路
 * @param {PartQueryDependencies} [dependencies] 依赖
 * @returns {void}
 */
export function handleIncomingPartQueryResponse(response, peerId = '', dependencies = {}) {
	const state = resolveState(dependencies)
	// 同一 peer 只计一次，防重复回包灌水/提早凑齐 expected
	const responderKey = String(peerId || response.fromNodeHash || '').trim().toLowerCase()
	const relay = state.relayPending.get(response.requestId)
	if (relay) {
		if (responderKey) {
			if (relay.respondedPeers.has(responderKey)) return
			relay.respondedPeers.add(responderKey)
		}
		relay.remoteRows.push(...response.rows)
		relay.received += 1
		if (relay.expected > 0 && relay.received >= relay.expected) flushRelayPending(relay)
		return
	}

	const bag = state.originBags.get(response.requestId)
	if (!bag) return
	if (responderKey) {
		if (bag.respondedPeers.has(responderKey)) return
		bag.respondedPeers.add(responderKey)
	}
	bag.rows = mergeQueryRows([bag.rows, response.rows], bag.maxHits, bag.rowKey)
	bag.received += 1
	if (bag.expected > 0 && bag.received >= bag.expected)
		finishMultiWireWaiters(state.originWaits, response.requestId, '')
}

/**
 * 多跳查询：本地 handler + 网络回流（反向路径聚合）；本地缓存命中则不广播。
 * @param {string} username trust graph 上下文
 * @param {string} partpath part 路径
 * @param {string} kind 查询标签
 * @param {unknown} query 不透明查询
 * @param {{
 *   ttl?: number
 *   timeoutMs?: number
 *   maxHits?: number
 *   rowKey?: (row: unknown) => string
 *   budget?: { maxHits?: number }
 * } & PartQueryDependencies} [options] 选项
 * @returns {Promise<unknown[]>} 合并后的 rows
 */
export async function queryNetwork(username, partpath, kind, query, options = {}) {
	const state = resolveState(options)
	const now = options.now || Date.now
	const nodeHashOf = options.getNodeHash || getNodeHash

	const cached = state.cache.get(partpath, kind, query, now())
	if (cached) return cached

	const ttl = Math.min(
		Math.max(1, Math.floor(Number(options.ttl) || partQueryTunables.maxTtl)),
		partQueryTunables.maxTtl,
	)
	const maxHits = Math.min(
		partQueryTunables.maxHits,
		Math.max(1, Math.floor(Number(options.maxHits ?? options.budget?.maxHits) || partQueryTunables.maxHits)),
	)
	// 第一跳中继等待 hopTimeout(ttl) 才 flush，发起端默认取 ttl+1 档以免先行超时
	const timeoutMs = Math.max(
		1,
		Math.floor(Number(options.timeoutMs) || resolvePartQueryHopTimeoutMs(ttl + 1)),
	)

	const localRows = await runLocalHandler(state, {
		replicaUsername: username,
		requesterNodeHash: nodeHashOf(),
	}, partpath, kind, query)

	/** @type {PartQueryReq} */
	const request = {
		requestId: randomUUID(),
		originNodeHash: nodeHashOf(),
		partpath: String(partpath || '').trim(),
		kind: String(kind || '').trim(),
		query,
		ttl,
		budget: { maxHits },
	}
	const parsed = parsePartQueryReq(request)
	if (!parsed) return mergeQueryRows([localRows], maxHits, options.rowKey)

	// 预占 dedupe：若查询绕环回流到本机，入站侧直接丢弃
	state.takeDedupe(parsed.requestId)

	const bag = {
		rows: [],
		maxHits,
		expected: 0,
		received: 0,
		respondedPeers: new Set(),
		rowKey: options.rowKey,
	}
	state.originBags.set(parsed.requestId, bag)
	const waitPromise = registerMultiWireWait(state.originWaits, parsed.requestId, '', timeoutMs, () => undefined)

	const selfHash = nodeHashOf()
	const exclude = new Set([selfHash, parsed.originNodeHash])
	const neighbors = await selectQueryNeighbors(username, exclude, options)
	let sent = 0
	for (const target of neighbors)
		if (await deliverQuery(username, target, 'part_query_req', parsed, options)) sent++
	bag.expected = sent

	// deliver 可能同步回流；在赋值 expected 后再检查是否已齐
	if (sent === 0 || bag.received >= bag.expected)
		finishMultiWireWaiters(state.originWaits, parsed.requestId, '')
	await waitPromise
	state.originBags.delete(parsed.requestId)

	const merged = mergeQueryRows([localRows, bag.rows], maxHits, options.rowKey)
	state.cache.set(parsed.partpath, parsed.kind, parsed.query, merged, now())
	return merged
}

/** @returns {void} 测试用重置默认状态 */
export function resetPartQueryStateForTests() {
	defaultState.handlers.clear()
	defaultState.relayPending.clear()
	defaultState.originWaits.clear()
	defaultState.originBags.clear()
	defaultState.cache.clear()
	defaultState.takeDedupe = createDedupeSlot({
		maxSize: partQueryTunables.dedupeMaxSize,
		ttlMs: partQueryTunables.dedupeTtlMs,
	})
}
