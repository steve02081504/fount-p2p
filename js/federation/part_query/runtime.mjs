import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'

import { canonicalStringify } from '../../core/canonical_json.mjs'
import { compositeKey } from '../../core/composite_key.mjs'
import { keyPairFromSeed, pubKeyHash, sign, verify } from '../../crypto/crypto.mjs'
import { ensureNodeSeed, getNodeHash } from '../../node/identity.mjs'
import { loadReputation } from '../../node/reputation_store.mjs'
import { isQuarantinedPure } from '../../reputation/engine.mjs'
import {
	clampPartQueryRows,
	parsePartQueryReq,
} from '../../schemas/part_query.mjs'
import partQueryTunables from '../../schemas/part_query.tunables.json' with { type: 'json' }
import { buildMergedGraph } from '../../trust_graph/build.mjs'
import { pickTopFromGraph } from '../../trust_graph/engine.mjs'
import { resolveFederationFanoutTopK } from '../../trust_graph/resolve.mjs'
import trustGraphTunables from '../../trust_graph/tunables.json' with { type: 'json' }
import { finishMultiWireWaiters, registerMultiWireWait } from '../../wire/wait.mjs'
import { createDedupeSlot } from '../dedupe_slot.mjs'

import { createPartQueryCache, partQueryCache } from './cache.mjs'

/** @typedef {import('../../schemas/part_query.mjs').PartQueryReq} PartQueryReq */
/** @typedef {import('../../schemas/part_query.mjs').PartQueryRes} PartQueryRes */

/** @typedef {import('../../wire/adapter.mjs').WireAdapter} PartQueryWire */

const PART_QUERY_DOMAIN = 'fount-part-query'

/**
 * 构造 part_query_res 签名材料：仅覆盖 (requestId, fromNodeHash, rows)。
 * 来源节点借此自证，中间节点无法篡改结果或来源。
 * @param {{ requestId: string, fromNodeHash: string, rows: unknown[] }} base 响应基体
 * @returns {Uint8Array} 待签名字节
 */
function partQuerySignBytes(base) {
	return Buffer.from(`${PART_QUERY_DOMAIN}\0${base.requestId}\0${base.fromNodeHash}\0${canonicalStringify(base.rows)}`, 'utf8')
}

/**
 * 默认响应签名：用本机节点身份签响应基体。
 * @param {{ requestId: string, fromNodeHash: string, rows: unknown[] }} base 响应基体
 * @returns {Promise<{ nodePubKey: string, sig: string }>} 公钥与签名
 */
async function defaultSignResponse(base) {
	const { publicKey, secretKey } = keyPairFromSeed(Buffer.from(ensureNodeSeed(), 'hex'))
	const signature = await sign(partQuerySignBytes(base), secretKey)
	return { nodePubKey: Buffer.from(publicKey).toString('hex'), sig: Buffer.from(signature).toString('hex') }
}

/**
 * 默认响应验签：nodePubKey 哈希须等于 fromNodeHash，且签名覆盖响应基体。
 * @param {{ requestId: string, fromNodeHash: string, rows: unknown[], nodePubKey: string, sig: string }} response 响应
 * @returns {Promise<boolean>} 是否可信
 */
async function defaultVerifyResponse(response) {
	if (pubKeyHash(Buffer.from(response.nodePubKey, 'hex')) !== response.fromNodeHash) return false
	return await verify(Buffer.from(response.sig, 'hex'), partQuerySignBytes(response), Buffer.from(response.nodePubKey, 'hex'))
}

/**
 * @param {PartQueryDependencies} dependencies 依赖
 * @returns {(base: { requestId: string, fromNodeHash: string, rows: unknown[] }) => Promise<{ nodePubKey: string, sig: string }>} 签名函数
 */
function responseSigner(dependencies) {
	return dependencies.signResponse || defaultSignResponse
}

/**
 * @param {PartQueryDependencies} dependencies 依赖
 * @returns {(response: { requestId: string, fromNodeHash: string, rows: unknown[], nodePubKey: string, sig: string }) => Promise<boolean>} 验签函数
 */
function responseVerifier(dependencies) {
	return dependencies.verifyResponse || defaultVerifyResponse
}

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
 *   originWaits: Map<string, Map<string, import('../../wire/wait.mjs').WireWaiter[]>>
 *   originBags: Map<string, { entries: Array<{ rows: unknown[], sourceNodeHash?: string }>, maxHits: number, expected: number, received: number, respondedPeers: Set<string>, rowKey?: (row: unknown) => string }>
 *   cache: ReturnType<typeof createPartQueryCache>
 *   handlers: Map<string, QueryInboundHandler>
 * }} PartQueryNodeState
 */

/**
 * @typedef {{ rows: unknown[], sourceNodeHash?: string }} QueryRowEntry
 */

/**
 * @typedef {{
 *   selectNeighbors?: (exclude: Set<string>) => Promise<string[]>
 *   deliver?: (nodeHash: string, action: string, payload: unknown) => Promise<boolean> | boolean
 *   getNodeHash?: () => string
 *   now?: () => number
 *   signResponse?: (base: { requestId: string, fromNodeHash: string, rows: unknown[] }) => Promise<{ nodePubKey: string, sig: string }>
 *   verifyResponse?: (response: { requestId: string, fromNodeHash: string, rows: unknown[], nodePubKey: string, sig: string }) => Promise<boolean>
 *   state?: PartQueryNodeState
 * }} PartQueryDependencies
 */

/**
 * @typedef {{
 *   upstreamPeerId: string
 *   wire: PartQueryWire
 *   request: PartQueryReq
 *   localRows: unknown[]
 *   remoteEntries: QueryRowEntry[]
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
export function resolvePartQueryState(dependencies = {}) {
	return dependencies.state || defaultState
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
	state.handlers.set(compositeKey(partpath, kind), handler)
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
	const keyOf = rowKey || (row => {
		try { return JSON.stringify(row) }
		catch { return `\0${out.length}` }
	})
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
 * 合并带来源的 rows，并记录每个去重行键的来源节点集合。
 * 本地行 `sourceNodeHash` 省略（不可被屏蔽）。
 * @param {QueryRowEntry[]} entries 多路 rows（含来源）
 * @param {number} maxHits 上限
 * @param {(row: unknown) => string} [rowKey] 去重键
 * @returns {{ rows: unknown[], sources: Map<string, Set<string>> }} 合并结果与 rowKey→来源集合
 */
function mergeRowsWithSources(entries, maxHits, rowKey) {
	const rows = []
	const seen = new Set()
	/** @type {Map<string, Set<string>>} */
	const sources = new Map()
	const keyOf = rowKey || (row => {
		try { return JSON.stringify(row) }
		catch { return `\0${rows.length}` }
	})
	for (const entry of entries)
		for (const row of entry.rows || []) {
			const key = keyOf(row)
			if (!seen.has(key)) {
				seen.add(key)
				rows.push(row)
				sources.set(key, new Set())
				if (entry.sourceNodeHash) sources.get(key).add(entry.sourceNodeHash)
				if (rows.length >= maxHits) return { rows, sources }
				continue
			}
			if (entry.sourceNodeHash) sources.get(key).add(entry.sourceNodeHash)
		}

	return { rows, sources }
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
	const handler = state.handlers.get(compositeKey(partpath, kind))
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
 * @param {string} nodeHash 目标
 * @param {string} action action 名
 * @param {unknown} payload 载荷
 * @param {PartQueryDependencies} dependencies 依赖
 * @returns {Promise<boolean>} 是否发出
 */
async function deliverQuery(nodeHash, action, payload, dependencies) {
	if (!dependencies.deliver) return false
	return Boolean(await dependencies.deliver(nodeHash, action, payload))
}

/**
 * @param {PartQueryReq} request 请求
 * @param {unknown[]} rows 行
 * @param {() => string} nodeHashOf 本机 hash
 * @returns {PartQueryRes} 响应载荷
 */
/**
 * @param {PartQueryReq} request 请求
 * @param {unknown[]} rows 行
 * @param {() => string} nodeHashOf 本机 hash
 * @param {PartQueryDependencies} dependencies 依赖
 * @returns {Promise<PartQueryRes>} 已签名的响应
 */
async function buildResponse(request, rows, nodeHashOf, dependencies) {
	const capped = clampPartQueryRows(rows, request.budget.maxHits) || []
	const base = { requestId: request.requestId, fromNodeHash: nodeHashOf(), rows: capped }
	const { nodePubKey, sig } = await responseSigner(dependencies)(base)
	return { ...base, nodePubKey, sig }
}

/**
 * 按来源屏蔽表过滤 rows：来源集合非空且全部被屏蔽时剔除该行。
 * @param {unknown[]} rows 行
 * @param {Map<string, Set<string>>} sources rowKey→来源集合
 * @param {(row: unknown) => string} [rowKey] 去重键
 * @param {((nodeHash: string) => boolean) | undefined} isSourceBlocked 来源屏蔽谓词
 * @returns {unknown[]} 过滤后的 rows
 */
function filterRowsBySource(rows, sources, rowKey, isSourceBlocked) {
	if (typeof isSourceBlocked !== 'function') return rows
	return rows.filter(row => {
		let key
		if (rowKey) key = rowKey(row)
		else
			try { key = JSON.stringify(row) }
			catch { return true }

		const set = sources.get(key)
		if (!set || set.size === 0) return true
		for (const source of set) if (!isSourceBlocked(source)) return true
		return false
	})
}

/**
 * @param {Map<string, Set<string>>} sources rowKey→来源集合
 * @returns {Map<string, string[]>} rowKey→来源数组
 */
function sourcesToArrays(sources) {
	const out = new Map()
	for (const [key, set] of sources) out.set(key, [...set])
	return out
}

/**
 * @param {RelayPending} pending 中继槽
 * @returns {Promise<void>}
 */
async function flushRelayPending(pending) {
	if (pending.flushed) return
	pending.flushed = true
	if (pending.timer) {
		clearTimeout(pending.timer)
		pending.timer = null
	}
	pending.state.relayPending.delete(pending.request.requestId)
	const merged = mergeRowsWithSources(
		[{ rows: pending.localRows }, ...pending.remoteEntries],
		pending.request.budget.maxHits,
	)
	const now = pending.dependencies.now || Date.now
	pending.state.cache.set(pending.request.partpath, pending.request.kind, pending.request.query, merged.rows, now(), merged.sources)
	const nodeHashOf = pending.dependencies.getNodeHash || getNodeHash
	try {
		pending.wire.send('part_query_res', await buildResponse(pending.request, merged.rows, nodeHashOf, pending.dependencies), pending.upstreamPeerId)
	}
	catch { /* disconnected */ }
}

/**
 * @param {{ replicaUsername?: string }} wireContext attach 上下文
 * @param {PartQueryWire} wire wire
 * @param {PartQueryReq} request 已校验请求
 * @param {string} peerId 来路
 * @param {PartQueryDependencies} dependencies 依赖
 * @returns {Promise<void>}
 */
export async function processIncomingPartQueryRequest(wireContext, wire, request, peerId, dependencies) {
	const state = resolvePartQueryState(dependencies)
	const nodeHashOf = dependencies.getNodeHash || getNodeHash
	const now = dependencies.now || Date.now
	const username = wireContext.replicaUsername || ''

	const cached = state.cache.getWithSources(request.partpath, request.kind, request.query, now())
	if (cached) {
		try { wire.send('part_query_res', await buildResponse(request, cached.rows, nodeHashOf, dependencies), peerId) }
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
		state.cache.set(request.partpath, request.kind, request.query, localRows, now(), new Map())
		try { wire.send('part_query_res', await buildResponse(request, localRows, nodeHashOf, dependencies), peerId) }
		catch { /* disconnected */ }
		return
	}

	const selfHash = nodeHashOf()
	const exclude = new Set([selfHash, request.originNodeHash, peerId].filter(Boolean))
	const forwardPayload = { ...request, ttl: nextTtl }

	/** @type {RelayPending} */
	const pending = {
		upstreamPeerId: peerId,
		wire,
		request,
		localRows,
		remoteEntries: [],
		expected: 0,
		received: 0,
		respondedPeers: new Set(),
		flushed: false,
		timer: null,
		dependencies,
		state,
	}
	state.relayPending.set(request.requestId, pending)
	// 先挂 hop 超时：勿等 select/deliver settle，否则 stuck send 永不 flush upstream（#13 同类）
	pending.timer = setTimeout(() => { void flushRelayPending(pending) }, resolvePartQueryHopTimeoutMs(request.ttl))

	void (async () => {
		try {
			const neighbors = username ? await selectQueryNeighbors(username, exclude, dependencies) : []
			if (pending.flushed) return
			let sent = 0
			for (const target of neighbors)
				if (await deliverQuery(target, 'part_query_req', forwardPayload, dependencies)) sent++
			if (pending.flushed) return
			pending.expected = sent
			if (sent === 0 || pending.received >= pending.expected)
				void flushRelayPending(pending)
		}
		catch {
			if (!pending.flushed) void flushRelayPending(pending)
		}
	})()
}

/**
 * @param {PartQueryRes} response 响应
 * @param {string} peerId 来路
 * @param {PartQueryDependencies} [dependencies] 依赖
 * @returns {void}
 */
export async function handleIncomingPartQueryResponse(response, peerId = '', dependencies = {}) {
	const state = resolvePartQueryState(dependencies)
	// 响应必须自证来源；验签失败直接丢弃，避免任意邻居伪造/投毒结果与缓存。
	if (!await responseVerifier(dependencies)(response)) return
	const responderKey = response.fromNodeHash
	const relay = state.relayPending.get(response.requestId)
	if (relay) {
		if (relay.respondedPeers.has(responderKey)) return
		relay.respondedPeers.add(responderKey)
		relay.remoteEntries.push({ rows: response.rows, sourceNodeHash: responderKey })
		relay.received += 1
		if (relay.expected > 0 && relay.received >= relay.expected) void flushRelayPending(relay)
		return
	}

	const bag = state.originBags.get(response.requestId)
	if (!bag) return
	if (bag.respondedPeers.has(responderKey)) return
	bag.respondedPeers.add(responderKey)
	bag.entries.push({ rows: response.rows, sourceNodeHash: responderKey })
	bag.received += 1
	if (bag.expected > 0 && bag.received >= bag.expected)
		finishMultiWireWaiters(state.originWaits, response.requestId, '')
}

/**
 * 多跳查询：本地 handler + 网络回流（反向路径聚合）；本地缓存命中则不广播。
 * `timeoutMs` 端到端约束：select/deliver 挂起也不阻塞返回。
 * @param {string} username trust graph 上下文
 * @param {string} partpath part 路径
 * @param {string} kind 查询标签
 * @param {unknown} query 不透明查询
 * @param {{
 *   ttl?: number
 *   timeoutMs?: number
 *   maxHits?: number
 *   rowKey?: (row: unknown) => string
 *   isSourceBlocked?: (nodeHash: string) => boolean
 *   budget?: { maxHits?: number }
 * } & PartQueryDependencies} [options] 选项
 * @returns {Promise<{ rows: unknown[], sources: Map<string, string[]> }>} 合并 rows 与每行来源节点
 */
export async function queryNetwork(username, partpath, kind, query, options = {}) {
	const state = resolvePartQueryState(options)
	const now = options.now || Date.now
	const nodeHashOf = options.getNodeHash || getNodeHash

	const cached = state.cache.getWithSources(partpath, kind, query, now())
	if (cached)
		return {
			rows: filterRowsBySource(cached.rows, cached.sources, options.rowKey, options.isSourceBlocked),
			sources: sourcesToArrays(cached.sources),
		}

	const ttl = Math.min(
		Math.max(1, Math.floor(Number(options.ttl) || partQueryTunables.maxTtl)),
		partQueryTunables.maxTtl,
	)
	const maxHits = Math.min(
		partQueryTunables.maxHits,
		Math.max(1, Math.floor(Number(options.maxHits ?? options.budget?.maxHits) || partQueryTunables.maxHits)),
	)
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
		partpath,
		kind,
		query,
		ttl,
		budget: { maxHits },
	}
	const parsed = parsePartQueryReq(request)
	if (!parsed) {
		const localOnly = mergeRowsWithSources([{ rows: localRows }], maxHits, options.rowKey)
		return { rows: localOnly.rows, sources: sourcesToArrays(localOnly.sources) }
	}

	state.takeDedupe(parsed.requestId)

	const bag = {
		entries: [],
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
	// 勿 await select/deliver：否则 timeout 已触发也要等扇出 settle（#13）
	void (async () => {
		try {
			const neighbors = await selectQueryNeighbors(username, exclude, options)
			let sent = 0
			for (const target of neighbors)
				if (await deliverQuery(target, 'part_query_req', parsed, options)) sent++
			bag.expected = sent
			if (sent === 0 || bag.received >= bag.expected)
				finishMultiWireWaiters(state.originWaits, parsed.requestId, '')
		}
		catch { /* pending wait 超时负责 settle */ }
	})()

	await waitPromise
	state.originBags.delete(parsed.requestId)

	const merged = mergeRowsWithSources([{ rows: localRows }, ...bag.entries], maxHits, options.rowKey)
	state.cache.set(parsed.partpath, parsed.kind, parsed.query, merged.rows, now(), merged.sources)
	return {
		rows: filterRowsBySource(merged.rows, merged.sources, options.rowKey, options.isSourceBlocked),
		sources: sourcesToArrays(merged.sources),
	}
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
