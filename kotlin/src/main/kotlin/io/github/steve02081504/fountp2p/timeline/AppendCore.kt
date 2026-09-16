package io.github.steve02081504.fountp2p.timeline

import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.core.nextHlc
import io.github.steve02081504.fountp2p.crypto.publicKeyFromSeed
import io.github.steve02081504.fountp2p.crypto.sign
import io.github.steve02081504.fountp2p.dag.computeEventId
import io.github.steve02081504.fountp2p.dag.eventBodyForSign
import io.github.steve02081504.fountp2p.dag.signPayloadBytes
import io.github.steve02081504.fountp2p.dag.sortedPrevEventIds
import io.github.steve02081504.fountp2p.federation.jsString
import io.github.steve02081504.fountp2p.federation.jsTruthy
import io.github.steve02081504.fountp2p.governance.computeDagTipIdsFromEvents

/**
 * `computeAppendHlcAndPrev` 的结果：HLC、前驱与末条事件。
 * @property hlc 追加事件应使用的 HLC
 * @property prevEventIds 排序去重后的前驱 id
 * @property last 已有事件的末条；没有时为 null（等价 JS `undefined`）
 */
data class AppendHlcAndPrev(
	val hlc: Map<String, Any?>,
	val prevEventIds: List<String>,
	val last: Map<String, Any?>?,
)

/**
 * 为追加事件计算 HLC 与 DAG 前驱（chat 群与 social 时间线共用）。
 * @param previous 已有事件
 * @param event 待追加事件
 * @param options `multiTip` 为真时 chat 在多 tip 时连接全部 tip
 * @return HLC、前驱与末条事件
 */
fun computeAppendHlcAndPrev(
	previous: List<Map<String, Any?>>,
	event: Map<String, Any?>,
	options: Map<String, Any?> = emptyMap(),
): AppendHlcAndPrev {
	val last = previous.lastOrNull()
	val timestamp = (event["timestamp"] as? Number)?.toDouble()
	val wallMs = if (timestamp != null && timestamp.isFinite()) timestamp.toLong() else null
	val hlc = nextHlc(last?.get("hlc"), wallMs)
	val tips = computeDagTipIdsFromEvents(previous)
	val explicitPrev = event["prev_event_ids"] as? List<*>
	val prevEventIds: List<String> = when {
		explicitPrev != null && explicitPrev.isNotEmpty() -> sortedPrevEventIds(event["prev_event_ids"])
		jsTruthy(options["multiTip"]) && tips.size > 1 -> sortedPrevEventIds(tips)
		tips.isNotEmpty() -> sortedPrevEventIds(tips)
		jsTruthy(last?.get("id")) -> listOf(jsString(last?.get("id")))
		else -> emptyList()
	}
	return AppendHlcAndPrev(hlc, prevEventIds, last)
}

/**
 * 使用 `eventBodyForSign` 规范签名并返回完整事件（social 时间线）。
 * @param base 事件基体（含 type/groupId/sender/hlc/prev_event_ids/content/node_id）
 * @param secretKey 签名密钥
 * @return 签名后事件
 */
suspend fun signTimelineEvent(base: Map<String, Any?>, secretKey: ByteArray): Map<String, Any?> {
	val body = eventBodyForSign(base)
	val id = computeEventId(body)
	val signature = sign(signPayloadBytes(body), secretKey)
	val out = LinkedHashMap(base)
	out["id"] = id
	out["signature"] = bytesToHex(signature)
	out["senderPubKey"] = bytesToHex(publicKeyFromSeed(secretKey))
	return out
}
