package io.github.steve02081504.fountp2p.wire

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.JsonObject
import io.github.steve02081504.fountp2p.core.JsonUndefined
import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.core.isPlainObject
import io.github.steve02081504.fountp2p.core.isSignatureHex128

/**
 * P2P / Trystero 入站 wire 公共工具（外来网络边界）。
 *
 * 等价 `js/wire/ingress.mjs`。
 */

/**
 * 解析 WebSocket / Trystero 入站 JSON 帧。
 * @param raw `ws` message（[ByteArray]）或字符串
 * @return 解析失败或非对象时为 null
 */
@Suppress("UNCHECKED_CAST")
fun parseInboundJson(raw: Any?): JsonObject? {
	if (!jsTruthy(raw)) return null
	val text = when (raw) {
		is String -> raw
		is ByteArray -> raw.toString(Charsets.UTF_8)
		else -> raw.toString()
	}
	val parsed = try {
		Json.parse(text)
	}
	catch (_: Exception) {
		return null
	}
	return if (isPlainObject(parsed)) parsed as JsonObject else null
}

/**
 * @param event 单条 DAG 行
 * @return 是否具备完整远程签名形态
 */
fun isSignedDagEventRow(event: Any?): Boolean {
	if (!isPlainObject(event)) return false
	val row = event as Map<*, *>
	return isHex64(row["id"]) != null && isSignatureHex128(row["signature"]) != null
}

/**
 * 从联邦 `dag_event` 载荷取出已签名事件行。
 * @param payload Trystero 载荷（完整签名事件）
 * @param groupId 本群 ID
 * @return 验形通过的事件；否则 null
 */
@Suppress("UNCHECKED_CAST")
fun extractInboundSignedEvent(payload: Any?, groupId: String): JsonObject? {
	if (!isSignedDagEventRow(payload)) return null
	val row = payload as Map<*, *>
	val payloadGroupId = row["groupId"]
	if (jsTruthy(payloadGroupId) && payloadGroupId != groupId) return null
	return payload as JsonObject
}

/** JS 真值语义（`if (!raw)`、`payload.groupId && ...`）。 */
private fun jsTruthy(value: Any?): Boolean = when (value) {
	null, JsonUndefined -> false
	is Boolean -> value
	is Double -> value != 0.0 && !value.isNaN()
	is Float -> value != 0f && !value.isNaN()
	is Number -> value.toDouble() != 0.0 && !value.toDouble().isNaN()
	is String -> value.isNotEmpty()
	else -> true
}
