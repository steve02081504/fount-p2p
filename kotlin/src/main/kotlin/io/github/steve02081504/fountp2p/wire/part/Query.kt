package io.github.steve02081504.fountp2p.wire.part

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.federation.part_query.PartQueryCache
import io.github.steve02081504.fountp2p.federation.part_query.PartQueryDependencies
import io.github.steve02081504.fountp2p.federation.part_query.PartQueryNodeState
import io.github.steve02081504.fountp2p.federation.part_query.PartQueryQueryOptions
import io.github.steve02081504.fountp2p.federation.part_query.PartQueryWire
import io.github.steve02081504.fountp2p.federation.part_query.QueryInboundContext
import io.github.steve02081504.fountp2p.federation.part_query.QueryInboundHandler
import io.github.steve02081504.fountp2p.federation.part_query.QueryNetworkResult
import io.github.steve02081504.fountp2p.federation.part_query.handleIncomingPartQueryResponse
import io.github.steve02081504.fountp2p.federation.part_query.processIncomingPartQueryRequest
import io.github.steve02081504.fountp2p.federation.part_query.queryNetwork as queryNetworkCore
import io.github.steve02081504.fountp2p.federation.part_query.registerQueryInboundHandler as registerQueryInboundHandlerCore
import io.github.steve02081504.fountp2p.federation.part_query.resetPartQueryStateForTests as resetPartQueryStateForTestsCore
import io.github.steve02081504.fountp2p.federation.part_query.resolvePartQueryHopTimeoutMs as resolvePartQueryHopTimeoutMsCore
import io.github.steve02081504.fountp2p.federation.part_query.resolvePartQueryState as resolvePartQueryStateCore
import io.github.steve02081504.fountp2p.schemas.PartQueryTunables
import io.github.steve02081504.fountp2p.schemas.parsePartQueryReq
import io.github.steve02081504.fountp2p.schemas.parsePartQueryRes
import io.github.steve02081504.fountp2p.transport.sendToNodeLink
import io.github.steve02081504.fountp2p.wire.WireAdapter
import io.github.steve02081504.fountp2p.wire.WireContext
import io.github.steve02081504.fountp2p.wire.consumeWireRateBucket
import io.github.steve02081504.fountp2p.wire.subscribeWire
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * part query wire 站点侧适配（等价 `js/wire/part/query.mjs`）。
 *
 * 订阅 `part_query_req` / `part_query_res`，处理站点侧 parse / dedupe / rate 限流，
 * 再交给 `federation` 的多跳状态机。
 */

private val partQueryWireScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

/**
 * @param dependencies 已注入依赖
 * @return 补齐默认 deliver（经 link_registry 投递）后的依赖
 */
fun withDefaultDeliver(dependencies: PartQueryDependencies = PartQueryDependencies()): PartQueryDependencies =
	dependencies.copy(
		deliver = dependencies.deliver ?: { nodeHash, action, payload ->
			sendToNodeLink(nodeHash, linkedMapOf("scope" to "node", "action" to action, "payload" to payload))
		},
	)

/**
 * 订阅 part_query_req / part_query_res，站点 parse / dedupe / rate 限流后交给 federation 状态机。
 * @param wireContext 站点上下文
 * @param wire wire
 * @param dependencies 已注入依赖（含 per-node state）
 * @return 取消订阅的 dispose
 */
fun attachPartQueryWire(
	wireContext: WireContext,
	wire: WireAdapter,
	dependencies: PartQueryDependencies = PartQueryDependencies(),
): () -> Unit {
	val deps = withDefaultDeliver(dependencies)
	val state = resolvePartQueryStateCore(deps)
	val queryWire = PartQueryWire { action, payload, peerId -> wire.send(action, payload, peerId) }
	return subscribeWire(
		wire,
		linkedMapOf(
			"part_query_req" to { data, peerId ->
				val request = parsePartQueryReq(data)
				if (request != null && state.takeDedupe.take(Json.str(request["requestId"]) ?: "")) {
					val source = peerId.ifEmpty { Json.str(request["originNodeHash"]) ?: "" }
					if (source.isEmpty() || consumeWireRateBucket(
							"part_query:$source",
							mapOf("maxCount" to PartQueryTunables.ratePerSourcePerMin),
						)
					)
						partQueryWireScope.launch {
							processIncomingPartQueryRequest(
								QueryInboundContext(replicaUsername = wireContext.replicaUsername),
								queryWire,
								request,
								peerId,
								deps,
							)
						}
				}
			},
			"part_query_res" to { data, peerId ->
				val response = parsePartQueryRes(data)
				if (response != null)
					partQueryWireScope.launch { handleIncomingPartQueryResponse(response, peerId, deps) }
			},
		),
	)
}

/**
 * 多跳查询；默认经 link_registry 投递（未注入 deliver 时）。
 * @param username trust graph 所有者
 * @param partpath part 路径
 * @param kind 查询标签
 * @param query 透传查询
 * @param options 选项
 * @return 合并后的 rows 与来源节点
 */
suspend fun queryNetwork(
	username: String,
	partpath: String,
	kind: String,
	query: Any?,
	options: PartQueryQueryOptions = PartQueryQueryOptions(),
): QueryNetworkResult = queryNetworkCore(
	username,
	partpath,
	kind,
	query,
	options.copy(dependencies = withDefaultDeliver(options.dependencies)),
)

/** @param cache 缓存（默认新建） @return 单节点运行时状态 */
fun createPartQueryNodeState(cache: PartQueryCache? = null): PartQueryNodeState =
	io.github.steve02081504.fountp2p.federation.part_query.createPartQueryNodeState(cache)

/**
 * 注册 kind 处理。
 * @param partpath part 路径
 * @param kind 查询标签
 * @param handler 处理匹配行
 * @param state 节点状态（默认共享状态）
 */
fun registerQueryInboundHandler(
	partpath: String,
	kind: String,
	handler: QueryInboundHandler,
	state: PartQueryNodeState = resolvePartQueryStateCore(),
) = registerQueryInboundHandlerCore(partpath, kind, handler, state)

/** @param dependencies 依赖 @return 节点状态 */
fun resolvePartQueryState(dependencies: PartQueryDependencies = PartQueryDependencies()): PartQueryNodeState =
	resolvePartQueryStateCore(dependencies)

/**
 * @param ttl 当前节点剩余 ttl
 * @param tunables 可调表
 * @return 等待下一跳超时
 */
fun resolvePartQueryHopTimeoutMs(ttl: Any?, tunables: Map<String, Any?>? = null): Double =
	resolvePartQueryHopTimeoutMsCore(ttl, tunables)

/** 重置共享状态（测试用）。 */
fun resetPartQueryStateForTests() = resetPartQueryStateForTestsCore()
