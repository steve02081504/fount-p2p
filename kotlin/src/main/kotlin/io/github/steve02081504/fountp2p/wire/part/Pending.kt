package io.github.steve02081504.fountp2p.wire.part

/**
 * part_invoke RPC 挂起槽表。
 *
 * 等价 `js/wire/part/pending.mjs`。
 */

/** 单个 RPC 请求的挂起槽。 */
class PendingPartInvoke(
	val responses: MutableList<Any?>,
	val finish: () -> Unit,
	val maxResponses: Int,
	val respondedPeers: MutableSet<String>,
)

/** 全局挂起槽表（键为 requestId）。 */
val pendingPartInvoke: MutableMap<String, PendingPartInvoke> = LinkedHashMap()

/**
 * 入站 part_invoke_response：写入对应 pending 槽。
 * @param payload 响应
 * @param peerId 对端 id，用于同 peer 去重
 */
fun handleIncomingPartInvokeResponse(payload: Any?, peerId: String = "") {
	val envelope = payload as? Map<*, *> ?: return
	val requestId = envelope["requestId"] as? String ?: return
	val pending = pendingPartInvoke[requestId] ?: return
	val response = envelope["response"]
	if (!isPartInvokeResponse(response)) return
	if (peerId.isNotEmpty()) {
		if (pending.respondedPeers.contains(peerId)) return
		pending.respondedPeers.add(peerId)
	}
	pending.responses.add(response)
	if (pending.responses.size >= pending.maxResponses) pending.finish()
}
