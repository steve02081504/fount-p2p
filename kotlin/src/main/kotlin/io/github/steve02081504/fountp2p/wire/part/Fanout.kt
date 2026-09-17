package io.github.steve02081504.fountp2p.wire.part

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.node.getNodeHash
import io.github.steve02081504.fountp2p.trust_graph.DEFAULT_TRUST_GRAPH_OWNER
import io.github.steve02081504.fountp2p.trust_graph.requireTrustGraphProvider
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * trust-graph part_invoke 扇出（等价 `js/wire/part/fanout.mjs`）。
 */

/** 时间线 part_timeline_put fanout 上限。 */
const val TIMELINE_FANOUT_LIMIT = 8

/** part_invoke RPC collect 默认应答数。 */
const val PART_INVOKE_FANOUT_DEFAULT = 6

/** collect 的超时兜底作用域（等价 JS 的 `setTimeout` not awaited）。 */
private val partFanoutScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

/**
 * @param partpath part 路径
 * @param invoke 调用体
 * @param nodeHash 来源节点（null/空时省略）
 * @param requestId RPC 请求 id（null/空时省略）
 * @return part_invoke 载荷
 */
private fun buildCollectPayload(partpath: String, invoke: Any?, nodeHash: String?, requestId: String?): Map<String, Any?> {
	val payload = linkedMapOf<String, Any?>("partpath" to partpath, "invoke" to invoke)
	if (!nodeHash.isNullOrEmpty()) payload["nodeHash"] = nodeHash
	if (!requestId.isNullOrEmpty()) payload["requestId"] = requestId
	return payload
}

/**
 * @param results collect 原始结果
 * @return 解包成功 result 的载荷
 */
fun partInvokeDataRows(results: List<Any?>): List<Any?> {
	val rows = mutableListOf<Any?>()
	for (row in results) {
		val data = unwrapPartInvokeResult(row)
		if (data != null) rows.add(data)
	}
	return rows
}

/**
 * @param results collect 原始结果
 * @return 邻居返回的错误消息
 */
fun partInvokeErrorMessages(results: List<Any?>): List<String> {
	val errors = mutableListOf<String>()
	for (row in results) {
		val message = Json.at(Json.at(row, "error"), "message")
		if (message is String && message.isNotEmpty()) errors.add(message)
	}
	return errors
}

/**
 * 向 trust-graph top-K 扇出 part_invoke，并收集 part_invoke_response。
 *
 * 调用方须已挂载 `attachPartWire`（负责收集 response）。
 * `timeoutMs` 端到端约束：fanout 挂起（discoverRoute / stuck send）也不阻塞返回。
 * @param username trust graph 所有者
 * @param partpath part 路径
 * @param invoke 调用体
 * @param timeoutMs 端到端超时
 * @param maxResponses 最大应答数
 * @return 邻居 PartInvokeResponse（含 error）
 */
@JvmOverloads
suspend fun collectPartInvokeResponses(
	username: String,
	partpath: String,
	invoke: Any?,
	timeoutMs: Long = 2500,
	maxResponses: Int = PART_INVOKE_FANOUT_DEFAULT,
): List<Any?> {
	val requestId = UUID.randomUUID().toString()
	val nodeHash = getNodeHash()
	val responses = mutableListOf<Any?>()
	val done = CompletableDeferred<Unit>()
	var timer: Job? = null

	fun finish() {
		timer?.cancel()
		pendingPartInvoke.remove(requestId)
		done.complete(Unit)
	}

	timer = partFanoutScope.launch {
		delay(timeoutMs)
		finish()
	}
	pendingPartInvoke[requestId] = PendingPartInvoke(responses, ::finish, maxResponses, mutableSetOf())

	// 不 await fanout：即使 timeout 已触发也要先 settle（#13）。
	partFanoutScope.launch {
		try {
			val sent = requireTrustGraphProvider(DEFAULT_TRUST_GRAPH_OWNER).fanoutToTopNodes(
				username,
				"part_invoke",
				buildCollectPayload(partpath, invoke, nodeHash, requestId),
				maxResponses,
			)
			if (sent == 0 && pendingPartInvoke.containsKey(requestId)) finish()
		}
		catch (_: Throwable) {
			// pending wait 超时兜底 settle
		}
	}

	done.await()
	return responses
}
