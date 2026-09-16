package io.github.steve02081504.fountp2p.federation

import io.github.steve02081504.fountp2p.core.Json

/**
 * 群级消息限速纯函数（无 I/O，供单测与 governance 复用）。
 */

/**
 * @param event DAG 事件
 * @return 限速实体键
 */
fun messageRateEntityKey(event: Any?): String {
	val charId = Json.at(event, "charId")
	if (jsTruthy(charId)) {
		val text = jsString(charId)
		if (text.isNotEmpty()) return "char:$text"
	}
	val sender = Json.at(event, "sender")
	return if (jsTruthy(sender)) jsString(sender) else ""
}

/**
 * @param groupSettings 群设置
 * @return 每分钟条数与窗口毫秒
 */
fun resolveMessageRateLimits(groupSettings: Any?): Map<String, Any?> {
	val perMin = maxOf(1.0, minOf(120.0, jsNumberOr(jsNumber(Json.at(groupSettings, "messageRateLimitPerMin")), 10.0)))
	val windowMs = maxOf(10_000.0, jsNumberOr(jsNumber(Json.at(groupSettings, "messageRateLimitWindowMs")), 60_000.0))
	return linkedMapOf("perMin" to perMin, "windowMs" to windowMs)
}
