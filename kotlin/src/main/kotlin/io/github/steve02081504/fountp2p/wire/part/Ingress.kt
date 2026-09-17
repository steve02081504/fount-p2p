package io.github.steve02081504.fountp2p.wire.part

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.JsonUndefined
import io.github.steve02081504.fountp2p.core.isPlainObject
import io.github.steve02081504.fountp2p.core.parsePartpath
import io.github.steve02081504.fountp2p.registries.InboundContext
import io.github.steve02081504.fountp2p.registries.dispatchDeliveryInbound
import io.github.steve02081504.fountp2p.registries.dispatchRpcInbound
import io.github.steve02081504.fountp2p.wire.WireAdapter
import io.github.steve02081504.fountp2p.wire.WireContext
import io.github.steve02081504.fountp2p.wire.subscribeWire
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * part wire 站点侧适配（等价 `js/wire/part/ingress.mjs`）。
 *
 * 处理 `part_timeline_put` / `part_invoke` / `part_invoke_response`。
 */

/** part wire 站点选项（等价 JS options）。 */
class PartWireOptions(
	/** 载荷不通过时直接丢弃，留给上层（shell）的放行边界。 */
	val allowPartInvoke: ((Map<String, Any?>) -> Boolean)? = null,
)

/** ingress / fanout 后台调度的作用域 */
private val partIngressScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

@Suppress("UNCHECKED_CAST")
private fun asObject(value: Any?): Map<String, Any?>? = value as? Map<String, Any?>

/**
 * @param data 入站 part_timeline_put 载荷
 * @param partpath 已校验 part 路径
 * @return 归一化字段，无效时为 null
 */
private fun parsePartTimelinePut(data: Map<String, Any?>, partpath: String): Map<String, Any?>? {
	val timelineEntityHash = Json.str(data["timelineEntityHash"]) ?: ""
	if (timelineEntityHash.isEmpty() || !isPlainObject(data["event"])) return null
	val message = linkedMapOf<String, Any?>(
		"type" to "part_timeline_put",
		"partpath" to partpath,
		"timelineEntityHash" to timelineEntityHash,
		"event" to data["event"],
	)
	if (data.containsKey("nodeHash")) message["nodeHash"] = Json.str(data["nodeHash"]) ?: ""
	if (data.containsKey("groupId")) message["groupId"] = Json.str(data["groupId"]) ?: ""
	return message
}

/**
 * @param partpath part 路径
 * @param invoke 调用体
 * @param nodeHash 来源节点（null 时省略）
 * @param groupId 群组名（null 时省略）
 * @return part_invoke 载荷
 */
private fun buildPartInvokePayload(partpath: String, invoke: Any?, nodeHash: String?, groupId: String?): Map<String, Any?> {
	val payload = linkedMapOf<String, Any?>("partpath" to partpath, "invoke" to invoke)
	if (!nodeHash.isNullOrEmpty()) payload["nodeHash"] = nodeHash
	if (!groupId.isNullOrEmpty()) payload["groupId"] = groupId
	return payload
}

/**
 * @param wireContext 站点上下文
 * @param payload part_invoke 请求（含已验证 peerId）
 * @return RPC 处理函数返回值
 */
private suspend fun dispatchPartInvoke(wireContext: WireContext, payload: Map<String, Any?>): Map<String, Any?>? {
	val partpath = parsePartpath(payload["partpath"]) ?: return null
	val invoke = payload["invoke"]
	if (!isPlainObject(invoke)) return null
	val peerId = Json.str(payload["peerId"])
	val groupId = Json.str(payload["groupId"])
	return dispatchRpcInbound(
		InboundContext(
			replicaUsername = wireContext.replicaUsername,
			requesterNodeHash = peerId?.takeIf { it.isNotEmpty() },
			groupId = groupId,
			peerId = peerId,
		),
		linkedMapOf(
			"type" to "part_invoke",
			"partpath" to partpath,
			"invoke" to invoke,
			"groupId" to (groupId ?: JsonUndefined),
			"requestId" to (Json.str(payload["requestId"]) ?: JsonUndefined),
		),
	)
}

/**
 * 订阅 part_timeline_put / part_invoke / part_invoke_response。
 * @param wireContext 站点上下文
 * @param wire action 层
 * @param options 站点选项
 * @return 取消订阅的 dispose
 */
fun attachPartWire(
	wireContext: WireContext,
	wire: WireAdapter,
	options: PartWireOptions = PartWireOptions(),
): () -> Unit = subscribeWire(
	wire,
	linkedMapOf(
		"part_timeline_put" to { data, peerId ->
			val payload = asObject(data)
			if (payload != null) {
				val partpath = parsePartpath(payload["partpath"])
				if (partpath != null) {
					val message = parsePartTimelinePut(payload, partpath)
					if (message != null)
						partIngressScope.launch {
							dispatchDeliveryInbound(
								InboundContext(
									replicaUsername = wireContext.replicaUsername,
									requesterNodeHash = peerId.takeIf { it.isNotEmpty() },
								),
								message,
							)
						}
				}
			}
		},
		"part_invoke" to { data, peerId ->
			val raw = asObject(data)
			if (raw != null && options.allowPartInvoke?.invoke(raw) != false) {
				val payload = raw.toMutableMap()
				payload["peerId"] = peerId
				partIngressScope.launch {
					if (Json.str(payload["requestId"]) != null)
						handleIncomingPartInvokeRequest(wireContext, payload, wire, peerId)
					else
						handleIncomingPartInvokeFireAndForget(wireContext, payload, wire, peerId)
				}
			}
		},
		"part_invoke_response" to { data, peerId ->
			val payload = asObject(data)
			if (payload != null) handleIncomingPartInvokeResponse(payload, peerId)
		},
	),
)

/**
 * @param wireContext 站点上下文
 * @param payload part_invoke 请求（含 requestId）
 * @param wire 发送侧 wire
 * @param peerId 自动
 */
suspend fun handleIncomingPartInvokeRequest(
	wireContext: WireContext,
	payload: Map<String, Any?>,
	wire: WireAdapter,
	peerId: String,
) {
	val partpath = parsePartpath(payload["partpath"]) ?: return
	val requestId = Json.str(payload["requestId"]) ?: return

	val request = payload.toMutableMap()
	request["peerId"] = peerId
	val response = dispatchPartInvoke(wireContext, request)
	if (!isPartInvokeResponse(response)) return

	try {
		wire.send(
			"part_invoke_response",
			linkedMapOf(
				"requestId" to requestId,
				"partpath" to partpath,
				"response" to response,
			),
			peerId,
		)
	}
	catch (_: Throwable) {
		// disconnected
	}
}

/**
 * @param wireContext 站点上下文
 * @param payload part_invoke 请求（无 requestId）
 * @param wire 发送侧 wire
 * @param peerId 自动
 */
suspend fun handleIncomingPartInvokeFireAndForget(
	wireContext: WireContext,
	payload: Map<String, Any?>,
	wire: WireAdapter,
	peerId: String,
) {
	val partpath = parsePartpath(payload["partpath"]) ?: return

	val request = payload.toMutableMap()
	request["peerId"] = peerId
	val response = dispatchPartInvoke(wireContext, request)
	val followUp = unwrapPartInvokeResult(response)
	if (!isPartInvoke(followUp)) return
	try {
		wire.send(
			"part_invoke",
			buildPartInvokePayload(partpath, followUp, peerId, Json.str(payload["groupId"])),
			peerId,
		)
	}
	catch (_: Throwable) {
		// disconnected
	}
}
