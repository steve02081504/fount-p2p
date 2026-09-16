package io.github.steve02081504.fountp2p.registries

/**
 * 入站 RPC / 投递处理器注册表（`registries/inbound.mjs` 的等价实现）。
 */

/** 入站上下文。 */
data class InboundContext(
	val replicaUsername: String? = null,
	val requesterNodeHash: String? = null,
	val groupId: String? = null,
	val peerId: String? = null,
)

/** 入站 RPC 处理器：返回 `{ result }` 或 `{ error }`，无处理则 null。 */
typealias RpcInboundHandler = suspend (InboundContext, Map<String, Any?>) -> Map<String, Any?>?

/** 入站投递处理器。 */
typealias DeliveryInboundHandler = suspend (InboundContext, Map<String, Any?>) -> Unit

/** type → RPC handler。 */
private val rpcHandlers = LinkedHashMap<String, RpcInboundHandler>()

/** type → 投递 handler。 */
private val deliveryHandlers = LinkedHashMap<String, DeliveryInboundHandler>()

/**
 * @param type 入站 RPC 类型（part_invoke 等）
 * @param handler 处理器
 */
fun registerRpcInboundHandler(type: String, handler: RpcInboundHandler) {
	rpcHandlers[type] = handler
}

/**
 * @param type 入站投递类型（part_timeline_put 等）
 * @param handler 处理器
 */
fun registerDeliveryInboundHandler(type: String, handler: DeliveryInboundHandler) {
	deliveryHandlers[type] = handler
}

/**
 * @param inboundContext 入站上下文
 * @param message 已校验的线载荷（含 type）
 * @return 处理器返回值；无处理器为 null
 */
suspend fun dispatchRpcInbound(
	inboundContext: InboundContext,
	message: Map<String, Any?>,
): Map<String, Any?>? {
	val handler = (message["type"] as? String)?.let { rpcHandlers[it] } ?: return null
	return handler(inboundContext, message)
}

/**
 * @param inboundContext 入站上下文
 * @param message 已校验的线载荷（含 type）
 */
suspend fun dispatchDeliveryInbound(inboundContext: InboundContext, message: Map<String, Any?>) {
	val handler = (message["type"] as? String)?.let { deliveryHandlers[it] } ?: return
	handler(inboundContext, message)
}
