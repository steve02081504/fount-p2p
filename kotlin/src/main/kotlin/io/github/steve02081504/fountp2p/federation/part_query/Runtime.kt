package io.github.steve02081504.fountp2p.federation.part_query

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.JsonUndefined
import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.core.canonicalStringify
import io.github.steve02081504.fountp2p.core.compositeKey
import io.github.steve02081504.fountp2p.core.hexToBytes
import io.github.steve02081504.fountp2p.crypto.keyPairFromSeed
import io.github.steve02081504.fountp2p.crypto.pubKeyHash
import io.github.steve02081504.fountp2p.crypto.sign
import io.github.steve02081504.fountp2p.crypto.verify
import io.github.steve02081504.fountp2p.federation.DedupeSlot
import io.github.steve02081504.fountp2p.federation.createDedupeSlot
import io.github.steve02081504.fountp2p.federation.jsNumber
import io.github.steve02081504.fountp2p.federation.jsNumberOr
import io.github.steve02081504.fountp2p.node.ensureNodeSeed
import io.github.steve02081504.fountp2p.node.getNodeHash
import io.github.steve02081504.fountp2p.node.loadReputation
import io.github.steve02081504.fountp2p.reputation.isQuarantinedPure
import io.github.steve02081504.fountp2p.schemas.PartQueryTunables
import io.github.steve02081504.fountp2p.schemas.clampPartQueryRows
import io.github.steve02081504.fountp2p.schemas.parsePartQueryReq
import io.github.steve02081504.fountp2p.trust_graph.TrustGraphTunables
import io.github.steve02081504.fountp2p.trust_graph.buildMergedGraph
import io.github.steve02081504.fountp2p.trust_graph.pickTopFromGraph
import io.github.steve02081504.fountp2p.trust_graph.resolveFederationFanoutTopK
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * part_query 单节点运行时（缓存 / 中继 / 多跳聚合）。
 *
 * `runtime.mjs` 的默认依赖（`node/identity` 的 `ensureNodeSeed` / `getNodeHash`、
 * `trust_graph` 的 `buildMergedGraph` / `pickTopFromGraph`、`reputation` 的隔离表）
 * 均已按 JS 默认实现接回；[PartQueryDependencies] 仍可注入覆盖：
 * - `selectNeighbors` / `getNodeHash` / `signResponse` / `verifyResponse` 未注入时走 JS 等价默认实现；
 * - 多 waiter 等待表是 `wire/wait.mjs` 多 waiter 子集的本地位移，待 wire 包移植后合并。
 */

private const val PART_QUERY_DOMAIN = "fount-part-query"

/** 进程内协程作用域：中继超时与扇出（等价 JS 的 fire-and-forget Promise）。 */
private val partQueryScope = CoroutineScope(Dispatchers.Default + SupervisorJob())

/**
 * 构造 part_query_res 签名材料：仅覆盖 (requestId, fromNodeHash, rows)。
 * @param base 响应基体
 * @return 待签名字节
 */
private fun partQuerySignBytes(base: Map<String, Any?>): ByteArray {
	val requestId = Json.str(base["requestId"]) ?: ""
	val fromNodeHash = Json.str(base["fromNodeHash"]) ?: ""
	val rows = base["rows"]
	return "$PART_QUERY_DOMAIN\u0000$requestId\u0000$fromNodeHash\u0000${canonicalStringify(rows)}".toByteArray(Charsets.UTF_8)
}

/**
 * 默认响应签名：用本机节点身份签响应基体。
 * @param base 响应基体
 * @return 公钥与签名
 */
private suspend fun defaultSignResponse(base: Map<String, Any?>): Map<String, Any?> {
	val keyPair = keyPairFromSeed(hexToBytes(ensureNodeSeed()))
	val signature = sign(partQuerySignBytes(base), keyPair.secretKey)
	return linkedMapOf("nodePubKey" to bytesToHex(keyPair.publicKey), "sig" to bytesToHex(signature))
}

/**
 * 默认响应验签：nodePubKey 哈希须等于 fromNodeHash，且签名覆盖响应基体。
 * @param response 响应
 * @return 是否可信
 */
private suspend fun defaultVerifyResponse(response: Map<String, Any?>): Boolean {
	val nodePubKey = Json.str(response["nodePubKey"]) ?: return false
	if (pubKeyHash(hexToBytes(nodePubKey)) != response["fromNodeHash"]) return false
	val sig = Json.str(response["sig"]) ?: return false
	return verify(hexToBytes(sig), partQuerySignBytes(response), hexToBytes(nodePubKey))
}

/** @param dependencies 依赖 @return 签名函数 */
private fun responseSigner(dependencies: PartQueryDependencies): suspend (Map<String, Any?>) -> Map<String, Any?> =
	dependencies.signResponse ?: ::defaultSignResponse

/** @param dependencies 依赖 @return 验签函数 */
private fun responseVerifier(dependencies: PartQueryDependencies): suspend (Map<String, Any?>) -> Boolean =
	dependencies.verifyResponse ?: ::defaultVerifyResponse

/** 入站查询上下文。 */
class QueryInboundContext(
	val replicaUsername: String? = null,
	val requesterNodeHash: String? = null,
	val peerId: String? = null,
)

/** 本地查询处理器：返回 rows；null 视作空。 */
typealias QueryInboundHandler = suspend (QueryInboundContext, Any?) -> List<Any?>?

/** 带来源的行条目。 */
class QueryRowEntry(val rows: List<Any?>, val sourceNodeHash: String? = null)

/** 发起端等待聚合的 bag。 */
class OriginBag(
	val entries: MutableList<QueryRowEntry> = mutableListOf(),
	var maxHits: Int = PartQueryTunables.maxHits,
	var expected: Int = 0,
	var received: Int = 0,
	val respondedPeers: MutableSet<String> = mutableSetOf(),
	val rowKey: ((Any?) -> String)? = null,
)

/** 多 waiter 等待表条目。 */
class PartQueryWireWaiter(val deferred: CompletableDeferred<Any?>, val timer: Job)

/** 单节点运行时状态。 */
class PartQueryNodeState(
	var takeDedupe: DedupeSlot,
	val relayPending: MutableMap<String, RelayPending> = mutableMapOf(),
	val originWaits: MutableMap<String, MutableMap<String, MutableList<PartQueryWireWaiter>>> = mutableMapOf(),
	val originBags: MutableMap<String, OriginBag> = mutableMapOf(),
	val cache: PartQueryCache,
	val handlers: MutableMap<String, QueryInboundHandler> = mutableMapOf(),
)

/** 中继中继槽。 */
class RelayPending(
	val upstreamPeerId: String,
	val wire: PartQueryWire,
	val request: Map<String, Any?>,
	val localRows: List<Any?>,
	val remoteEntries: MutableList<QueryRowEntry> = mutableListOf(),
	var expected: Int = 0,
	var received: Int = 0,
	val respondedPeers: MutableSet<String> = mutableSetOf(),
	var flushed: Boolean = false,
	var timer: Job? = null,
	val dependencies: PartQueryDependencies = PartQueryDependencies(),
	val state: PartQueryNodeState,
)

/** wire 发送接口（`send(action, payload, peerId)`）。 */
fun interface PartQueryWire {
	fun send(action: String, payload: Any?, peerId: String?)
}

/** 可注入依赖。 */
class PartQueryDependencies(
	val selectNeighbors: (suspend (Set<String>) -> List<String>)? = null,
	val deliver: (suspend (String, String, Any?) -> Boolean)? = null,
	val getNodeHash: (() -> String)? = null,
	val now: (() -> Long)? = null,
	val signResponse: (suspend (Map<String, Any?>) -> Map<String, Any?>)? = null,
	val verifyResponse: (suspend (Map<String, Any?>) -> Boolean)? = null,
	val state: PartQueryNodeState? = null,
) {
	/** @return 逐字段拷贝，仅覆盖显式传入的字段 */
	fun copy(
		selectNeighbors: (suspend (Set<String>) -> List<String>)? = this.selectNeighbors,
		deliver: (suspend (String, String, Any?) -> Boolean)? = this.deliver,
		getNodeHash: (() -> String)? = this.getNodeHash,
		now: (() -> Long)? = this.now,
		signResponse: (suspend (Map<String, Any?>) -> Map<String, Any?>)? = this.signResponse,
		verifyResponse: (suspend (Map<String, Any?>) -> Boolean)? = this.verifyResponse,
		state: PartQueryNodeState? = this.state,
	): PartQueryDependencies = PartQueryDependencies(
		selectNeighbors = selectNeighbors,
		deliver = deliver,
		getNodeHash = getNodeHash,
		now = now,
		signResponse = signResponse,
		verifyResponse = verifyResponse,
		state = state,
	)
}

/**
 * @param cache 缓存（默认新建）
 * @return 单节点运行时状态
 */
fun createPartQueryNodeState(cache: PartQueryCache? = null): PartQueryNodeState = PartQueryNodeState(
	takeDedupe = createDedupeSlot(
		mapOf("maxSize" to PartQueryTunables.dedupeMaxSize, "ttlMs" to PartQueryTunables.dedupeTtlMs),
	),
	cache = cache ?: createPartQueryCache(),
)

/** 本进程默认单节点状态 */
private val defaultState: PartQueryNodeState = createPartQueryNodeState(partQueryCache)

/**
 * @param dependencies 依赖
 * @return 节点状态
 */
fun resolvePartQueryState(dependencies: PartQueryDependencies = PartQueryDependencies()): PartQueryNodeState =
	dependencies.state ?: defaultState

/**
 * Shell 注册 kind 语义处理器（怎么匹配、返回什么）。
 * @param partpath part 路径
 * @param kind 查询标签（如 entity_search）
 * @param handler 本地匹配器
 * @param state 节点状态（默认本机）
 */
fun registerQueryInboundHandler(
	partpath: String,
	kind: String,
	handler: QueryInboundHandler,
	state: PartQueryNodeState = defaultState,
) {
	state.handlers[compositeKey(partpath, kind)] = handler
}

/**
 * ttl 越大等得越久；发起端用 `ttl + 1` 取值，保证严格长于第一跳中继的 flush 超时。
 * @param ttl 当前节点剩余 ttl
 * @param tunables 可调（`hopTimeoutMs` / `defaultTimeoutMs`）
 * @return 等待下游超时
 */
fun resolvePartQueryHopTimeoutMs(ttl: Any?, tunables: Map<String, Any?>? = null): Double {
	val table: List<*> = (tunables?.get("hopTimeoutMs") as? List<*>) ?: PartQueryTunables.hopTimeoutMs
	val floorTtl = Math.floor(jsNumber(ttl))
	val index = Math.max(0.0, Math.min((table.size - 1).toDouble(), floorTtl - 1.0))
	val raw = if (index.isNaN()) Double.NaN else jsNumber(table.getOrNull(index.toInt()))
	val fallback = Json.num(tunables?.get("defaultTimeoutMs")) ?: PartQueryTunables.defaultTimeoutMs.toDouble()
	val effective = if (raw.isNaN() || raw == 0.0) fallback else raw
	return Math.max(1.0, Math.floor(effective))
}

/**
 * @param lists 多路 rows
 * @param maxHits 上限
 * @param rowKey 去重键
 * @return 合并去重后的 rows
 */
fun mergeQueryRows(lists: List<Any?>, maxHits: Number, rowKey: ((Any?) -> String)? = null): List<Any?> {
	val out = mutableListOf<Any?>()
	val seen = mutableSetOf<String>()
	val keyOf: (Any?) -> String = rowKey ?: run {
		{ row: Any? ->
			try {
				Json.stringify(row) ?: "undefined"
			}
			catch (_: Exception) {
				"\u0000${out.size}"
			}
		}
	}
	for (list in lists) {
		if (list !is List<*>) continue
		for (row in list) {
			val key = keyOf(row)
			if (seen.contains(key)) continue
			seen.add(key)
			out.add(row)
			if (out.size >= maxHits.toInt()) return out
		}
	}
	return out
}

/** 合并 rows 与 rowKey→来源集合。 */
class MergedRows(val rows: List<Any?>, val sources: PartQuerySources)

/**
 * 合并带来源的 rows，并记录每个去重行键的来源节点集合。
 * 本地行 `sourceNodeHash` 省略（不可被屏蔽）。
 * @param entries 多路 rows（含来源）
 * @param maxHits 上限
 * @param rowKey 去重键
 * @return 合并结果与 rowKey→来源集合
 */
private fun mergeRowsWithSources(entries: List<QueryRowEntry>, maxHits: Int, rowKey: ((Any?) -> String)?): MergedRows {
	val rows = mutableListOf<Any?>()
	val seen = mutableSetOf<String>()
	val sources: PartQuerySources = mutableMapOf()
	val keyOf: (Any?) -> String = rowKey ?: run {
		{ row: Any? ->
			try {
				Json.stringify(row) ?: "undefined"
			}
			catch (_: Exception) {
				"\u0000${rows.size}"
			}
		}
	}
	for (entry in entries) {
		for (row in entry.rows) {
			val key = keyOf(row)
			if (!seen.contains(key)) {
				seen.add(key)
				rows.add(row)
				sources[key] = mutableSetOf()
				entry.sourceNodeHash?.let { sources[key]!!.add(it) }
				if (rows.size >= maxHits) return MergedRows(rows, sources)
				continue
			}
			entry.sourceNodeHash?.let { sources[key]!!.add(it) }
		}
	}
	return MergedRows(rows, sources)
}

/**
 * @param state 节点状态
 * @param queryContext 入站上下文
 * @param partpath part 路径
 * @param kind 查询标签
 * @param query 查询体
 * @return 本地 rows
 */
private suspend fun runLocalHandler(
	state: PartQueryNodeState,
	queryContext: QueryInboundContext,
	partpath: String,
	kind: String,
	query: Any?,
): List<Any?> {
	val handler = state.handlers[compositeKey(partpath, kind)] ?: return emptyList()
	return handler(queryContext, query) ?: emptyList()
}

/**
 * @param username trust graph 上下文
 * @param exclude 排除节点
 * @param dependencies 可注入依赖
 * @return 邻居 nodeHash
 */
private suspend fun selectQueryNeighbors(
	username: String,
	exclude: Set<String>,
	dependencies: PartQueryDependencies,
): List<String> {
	dependencies.selectNeighbors?.let { return it(exclude) }
	val graph = buildMergedGraph(username)
	val fanoutCap = maxOf(1, PartQueryTunables.fanoutCap)
	val k = minOf(fanoutCap, resolveFederationFanoutTopK(graph.size, TrustGraphTunables.map))
	val rep = loadReputation()
	@Suppress("UNCHECKED_CAST")
	val byNodeHash = rep["byNodeHash"] as? Map<String, Any?> ?: emptyMap()
	val quarantined = byNodeHash.keys.filter { isQuarantinedPure(rep, it) }.toSet()
	val oversample = minOf(graph.size, k + exclude.size + 2)
	return pickTopFromGraph(graph, oversample.toDouble(), TrustGraphTunables.map, quarantined)
		.map { it.nodeHash }
		.filter { !exclude.contains(it) }
		.take(k)
}

/**
 * @param nodeHash 目标
 * @param action action 名
 * @param payload 载荷
 * @param dependencies 依赖
 * @return 是否发出
 */
private suspend fun deliverQuery(
	nodeHash: String,
	action: String,
	payload: Any?,
	dependencies: PartQueryDependencies,
): Boolean {
	val deliver = dependencies.deliver ?: return false
	return deliver(nodeHash, action, payload)
}

/** @return 请求的 budget.maxHits */
private fun budgetMaxHits(request: Map<String, Any?>): Double =
	Json.num(Json.at(Json.at(request, "budget"), "maxHits")) ?: PartQueryTunables.maxHits.toDouble()

/**
 * @param request 请求
 * @param rows 行
 * @param nodeHashOf 本机 hash
 * @param dependencies 依赖
 * @return 已签名的响应
 */
private suspend fun buildResponse(
	request: Map<String, Any?>,
	rows: List<Any?>,
	nodeHashOf: () -> String,
	dependencies: PartQueryDependencies,
): Map<String, Any?> {
	val capped = clampPartQueryRows(rows, budgetMaxHits(request)) ?: emptyList()
	val base = linkedMapOf<String, Any?>(
		"requestId" to request["requestId"],
		"fromNodeHash" to nodeHashOf(),
		"rows" to capped,
	)
	val signed = responseSigner(dependencies).invoke(base)
	val out = LinkedHashMap(base)
	out["nodePubKey"] = signed["nodePubKey"]
	out["sig"] = signed["sig"]
	return out
}

/**
 * 按来源屏蔽表过滤 rows：来源集合非空且全部被屏蔽时剔除该行。
 * @param rows 行
 * @param sources rowKey→来源集合
 * @param rowKey 去重键
 * @param isSourceBlocked 来源屏蔽谓词
 * @return 过滤后的 rows
 */
private fun filterRowsBySource(
	rows: List<Any?>,
	sources: PartQuerySources,
	rowKey: ((Any?) -> String)?,
	isSourceBlocked: ((String) -> Boolean)?,
): List<Any?> {
	if (isSourceBlocked == null) return rows
	return rows.filter { row ->
		val key = if (rowKey != null) rowKey(row)
		else try {
			Json.stringify(row) ?: "undefined"
		}
		catch (_: Exception) {
			return@filter true
		}
		val set = sources[key]
		if (set == null || set.isEmpty()) return@filter true
		for (source in set) if (!isSourceBlocked(source)) return@filter true
		false
	}
}

/** @return rowKey→来源数组 */
private fun sourcesToArrays(sources: PartQuerySources): Map<String, List<String>> {
	val out = mutableMapOf<String, List<String>>()
	for ((key, set) in sources) out[key] = set.toList()
	return out
}

/**
 * 多 waiter 注册（对应 `wire/wait.mjs#registerMultiWireWait`）。
 * @param pending 多 waiter 表
 * @param keyPrefix 键前缀
 * @param suffixKey 后缀键
 * @param timeoutMs 超时毫秒
 * @param onTimeout 超时返回值
 * @return 完成 deferred
 */
private fun registerMultiWireWait(
	pending: MutableMap<String, MutableMap<String, MutableList<PartQueryWireWaiter>>>,
	keyPrefix: String,
	suffixKey: String,
	timeoutMs: Long,
	onTimeout: () -> Any?,
): CompletableDeferred<Any?> {
	val deferred = CompletableDeferred<Any?>()
	val timer = partQueryScope.launch {
		delay(timeoutMs)
		finishMultiWireWaiters(pending, keyPrefix, suffixKey)
		deferred.complete(onTimeout())
	}
	val bucket = pending.getOrPut(keyPrefix) { mutableMapOf() }
	val waiters = bucket.getOrPut(suffixKey) { mutableListOf() }
	waiters.add(PartQueryWireWaiter(deferred, timer))
	return deferred
}

/**
 * 完成多 waiter（对应 `wire/wait.mjs#finishMultiWireWaiters`）。
 * @param pending 多 waiter 表
 * @param keyPrefix 键前缀
 * @param suffixKey 后缀键
 */
private fun finishMultiWireWaiters(
	pending: MutableMap<String, MutableMap<String, MutableList<PartQueryWireWaiter>>>,
	keyPrefix: String,
	suffixKey: String,
) {
	val bucket = pending[keyPrefix] ?: return
	val waiters = bucket[suffixKey] ?: return
	if (waiters.isEmpty()) return
	bucket.remove(suffixKey)
	if (bucket.isEmpty()) pending.remove(keyPrefix)
	for (waiter in waiters) {
		waiter.timer.cancel()
		waiter.deferred.complete(Unit)
	}
}

/**
 * @param pending 中继槽
 */
private suspend fun flushRelayPending(pending: RelayPending) {
	if (pending.flushed) return
	pending.flushed = true
	pending.timer?.cancel()
	pending.timer = null
	pending.state.relayPending.remove(Json.str(pending.request["requestId"]) ?: "")
	val merged = mergeRowsWithSources(
		listOf(QueryRowEntry(pending.localRows)) + pending.remoteEntries,
		budgetMaxHits(pending.request).toInt(),
		null,
	)
	val now = pending.dependencies.now ?: System::currentTimeMillis
	pending.state.cache.set(
		pending.request["partpath"],
		pending.request["kind"],
		pending.request["query"],
		merged.rows,
		now(),
		merged.sources,
	)
	val nodeHashOf = pending.dependencies.getNodeHash ?: ::getNodeHash
	try {
		pending.wire.send("part_query_res", buildResponse(pending.request, merged.rows, nodeHashOf, pending.dependencies), pending.upstreamPeerId)
	}
	catch (_: Exception) {
		// disconnected
	}
}

/**
 * @param wireContext attach 上下文
 * @param wire wire
 * @param request 已校验请求
 * @param peerId 来路
 * @param dependencies 依赖
 */
suspend fun processIncomingPartQueryRequest(
	wireContext: QueryInboundContext,
	wire: PartQueryWire,
	request: Map<String, Any?>,
	peerId: String,
	dependencies: PartQueryDependencies,
) {
	val state = resolvePartQueryState(dependencies)
	val nodeHashOf = dependencies.getNodeHash ?: ::getNodeHash
	val now = dependencies.now ?: System::currentTimeMillis
	val username = wireContext.replicaUsername ?: ""

	val cached = state.cache.getWithSources(request["partpath"], request["kind"], request["query"], now())
	if (cached != null) {
		try {
			wire.send("part_query_res", buildResponse(request, cached.rows, nodeHashOf, dependencies), peerId)
		}
		catch (_: Exception) {
			// disconnected
		}
		return
	}

	val partpath = request["partpath"] as String
	val kind = request["kind"] as String
	val localRows = runLocalHandler(
		state,
		QueryInboundContext(
			replicaUsername = wireContext.replicaUsername,
			requesterNodeHash = Json.str(request["originNodeHash"]),
			peerId = peerId,
		),
		partpath,
		kind,
		request["query"],
	)

	val nextTtl = (Json.int(request["ttl"]) ?: 0) - 1
	if (nextTtl <= 0) {
		state.cache.set(request["partpath"], request["kind"], request["query"], localRows, now(), mutableMapOf())
		try {
			wire.send("part_query_res", buildResponse(request, localRows, nodeHashOf, dependencies), peerId)
		}
		catch (_: Exception) {
			// disconnected
		}
		return
	}

	val selfHash = nodeHashOf()
	val exclude = listOfNotNull(selfHash, Json.str(request["originNodeHash"]), peerId)
		.filter { it.isNotEmpty() }
		.toMutableSet()
	val forwardPayload = LinkedHashMap(request).apply { put("ttl", nextTtl) }

	val pending = RelayPending(
		upstreamPeerId = peerId,
		wire = wire,
		request = request,
		localRows = localRows,
		dependencies = dependencies,
		state = state,
	)
	state.relayPending[Json.str(request["requestId"]) ?: ""] = pending
	// 先挂 hop 超时：勿等 select/deliver settle，否则 stuck send 永不 flush upstream（#13 同类）
	pending.timer = partQueryScope.launch {
		delay(resolvePartQueryHopTimeoutMs(request["ttl"]).toLong())
		flushRelayPending(pending)
	}

	partQueryScope.launch {
		try {
			val neighbors = if (username.isNotEmpty()) selectQueryNeighbors(username, exclude, dependencies) else emptyList()
			if (pending.flushed) return@launch
			var sent = 0
			for (target in neighbors) if (deliverQuery(target, "part_query_req", forwardPayload, dependencies)) sent++
			if (pending.flushed) return@launch
			pending.expected = sent
			if (sent == 0 || pending.received >= pending.expected) flushRelayPending(pending)
		}
		catch (_: Exception) {
			if (!pending.flushed) flushRelayPending(pending)
		}
	}
}

/**
 * @param response 响应
 * @param peerId 来路
 * @param dependencies 依赖
 */
suspend fun handleIncomingPartQueryResponse(
	response: Map<String, Any?>,
	@Suppress("UNUSED_PARAMETER") peerId: String = "",
	dependencies: PartQueryDependencies = PartQueryDependencies(),
) {
	val state = resolvePartQueryState(dependencies)
	// 响应必须自证来源；验签失败直接丢弃，避免任意邻居伪造/投毒结果与缓存。
	if (!responseVerifier(dependencies).invoke(response)) return
	val responderKey = Json.str(response["fromNodeHash"])
	if (responderKey == null) return
	val requestId = Json.str(response["requestId"]) ?: return
	val rows = Json.arr(response["rows"]) ?: emptyList()

	val relay = state.relayPending[requestId]
	if (relay != null) {
		if (relay.respondedPeers.contains(responderKey)) return
		relay.respondedPeers.add(responderKey)
		relay.remoteEntries.add(QueryRowEntry(rows, responderKey))
		relay.received += 1
		if (relay.expected > 0 && relay.received >= relay.expected) flushRelayPending(relay)
		return
	}

	val bag = state.originBags[requestId] ?: return
	if (bag.respondedPeers.contains(responderKey)) return
	bag.respondedPeers.add(responderKey)
	bag.entries.add(QueryRowEntry(rows, responderKey))
	bag.received += 1
	if (bag.expected > 0 && bag.received >= bag.expected)
		finishMultiWireWaiters(state.originWaits, requestId, "")
}

/** 多跳查询选项（含注入依赖）。 */
class PartQueryQueryOptions(
	val ttl: Any? = null,
	val timeoutMs: Any? = null,
	val maxHits: Any? = null,
	val rowKey: ((Any?) -> String)? = null,
	val isSourceBlocked: ((String) -> Boolean)? = null,
	val budget: Map<String, Any?>? = null,
	val dependencies: PartQueryDependencies = PartQueryDependencies(),
) {
	/** @return 逐字段拷贝，仅覆盖显式传入的字段 */
	fun copy(
		ttl: Any? = this.ttl,
		timeoutMs: Any? = this.timeoutMs,
		maxHits: Any? = this.maxHits,
		rowKey: ((Any?) -> String)? = this.rowKey,
		isSourceBlocked: ((String) -> Boolean)? = this.isSourceBlocked,
		budget: Map<String, Any?>? = this.budget,
		dependencies: PartQueryDependencies = this.dependencies,
	): PartQueryQueryOptions = PartQueryQueryOptions(
		ttl = ttl,
		timeoutMs = timeoutMs,
		maxHits = maxHits,
		rowKey = rowKey,
		isSourceBlocked = isSourceBlocked,
		budget = budget,
		dependencies = dependencies,
	)
}

/** 多跳查询结果。 */
class QueryNetworkResult(val rows: List<Any?>, val sources: Map<String, List<String>>)

/**
 * 多跳查询：本地 handler + 网络回流（反向路径聚合）；本地缓存命中则不广播。
 * @param username trust graph 上下文
 * @param partpath part 路径
 * @param kind 查询标签
 * @param query 不透明查询
 * @param options 选项
 * @return 合并 rows 与每行来源节点
 */
suspend fun queryNetwork(
	username: String,
	partpath: String,
	kind: String,
	query: Any?,
	options: PartQueryQueryOptions = PartQueryQueryOptions(),
): QueryNetworkResult {
	val dependencies = options.dependencies
	val state = resolvePartQueryState(dependencies)
	val now = dependencies.now ?: System::currentTimeMillis
	val nodeHashOf = dependencies.getNodeHash ?: ::getNodeHash

	val cached = state.cache.getWithSources(partpath, kind, query, now())
	if (cached != null) {
		return QueryNetworkResult(
			filterRowsBySource(cached.rows, cached.sources, options.rowKey, options.isSourceBlocked),
			sourcesToArrays(cached.sources),
		)
	}

	val ttl = Math.min(
		Math.max(1.0, Math.floor(jsNumberOr(jsNumber(options.ttl), PartQueryTunables.maxTtl.toDouble()))),
		PartQueryTunables.maxTtl.toDouble(),
	).toInt()
	val maxHitsRaw = options.maxHits ?: options.budget?.get("maxHits")
	val maxHits = Math.min(
		PartQueryTunables.maxHits.toDouble(),
		Math.max(1.0, Math.floor(jsNumberOr(jsNumber(maxHitsRaw), PartQueryTunables.maxHits.toDouble()))),
	).toInt()
	val timeoutMs = Math.max(
		1.0,
		Math.floor(jsNumberOr(jsNumber(options.timeoutMs), resolvePartQueryHopTimeoutMs(ttl + 1))),
	).toLong()

	val localRows = runLocalHandler(
		state,
		QueryInboundContext(replicaUsername = username, requesterNodeHash = nodeHashOf()),
		partpath,
		kind,
		query,
	)

	val request = linkedMapOf<String, Any?>(
		"requestId" to UUID.randomUUID().toString(),
		"originNodeHash" to nodeHashOf(),
		"partpath" to partpath,
		"kind" to kind,
		"query" to query,
		"ttl" to ttl,
		"budget" to linkedMapOf<String, Any?>("maxHits" to maxHits),
	)
	val parsed = parsePartQueryReq(request)
	if (parsed == null) {
		val localOnly = mergeRowsWithSources(listOf(QueryRowEntry(localRows)), maxHits, options.rowKey)
		return QueryNetworkResult(localOnly.rows, sourcesToArrays(localOnly.sources))
	}

	val requestId = Json.str(parsed["requestId"]) ?: return QueryNetworkResult(emptyList(), emptyMap())
	state.takeDedupe.take(requestId)

	val bag = OriginBag(maxHits = maxHits, rowKey = options.rowKey)
	state.originBags[requestId] = bag
	// 勿 await select/deliver：否则 timeout 已触发也要等扇出 settle（#13）
	val waitDeferred = registerMultiWireWait(state.originWaits, requestId, "", timeoutMs) { JsonUndefined }

	val selfHash = nodeHashOf()
	val exclude = mutableSetOf(selfHash, Json.str(parsed["originNodeHash"]) ?: "")
	partQueryScope.launch {
		try {
			val neighbors = selectQueryNeighbors(username, exclude, dependencies)
			var sent = 0
			for (target in neighbors) if (deliverQuery(target, "part_query_req", parsed, dependencies)) sent++
			bag.expected = sent
			if (sent == 0 || bag.received >= bag.expected)
				finishMultiWireWaiters(state.originWaits, requestId, "")
		}
		catch (_: Exception) {
			// pending wait 超时负责 settle
		}
	}

	waitDeferred.await()
	state.originBags.remove(requestId)

	val merged = mergeRowsWithSources(listOf(QueryRowEntry(localRows)) + bag.entries, maxHits, options.rowKey)
	state.cache.set(parsed["partpath"], parsed["kind"], parsed["query"], merged.rows, now(), merged.sources)
	return QueryNetworkResult(
		filterRowsBySource(merged.rows, merged.sources, options.rowKey, options.isSourceBlocked),
		sourcesToArrays(merged.sources),
	)
}

/** 测试用重置默认状态 */
fun resetPartQueryStateForTests() {
	defaultState.handlers.clear()
	defaultState.relayPending.clear()
	defaultState.originWaits.clear()
	defaultState.originBags.clear()
	defaultState.cache.clear()
	defaultState.takeDedupe = createDedupeSlot(
		mapOf("maxSize" to PartQueryTunables.dedupeMaxSize, "ttlMs" to PartQueryTunables.dedupeTtlMs),
	)
}
