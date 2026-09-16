package io.github.steve02081504.fountp2p.federation

import io.github.steve02081504.fountp2p.core.JsonUndefined

/**
 * 等价 JS `Number(value)`（ECMAScript ToNumber）。
 *
 * federation 层多处使用 `Number(...) || 默认值` 语义，需要精确的 NaN / 0 判定，
 * 而 [io.github.steve02081504.fountp2p.core.Json.num] 只接受数字类型。
 * @param value 任意值
 * @return 数值；不可转换时为 `NaN`
 */
internal fun jsNumber(value: Any?): Double = when (value) {
	null -> 0.0
	JsonUndefined -> Double.NaN
	is Boolean -> if (value) 1.0 else 0.0
	is Number -> value.toDouble()
	is String -> jsStringToNumber(value)
	else -> Double.NaN
}

/**
 * 等价 JS `a || b`：`a` 为 NaN 或 ±0 时取 `b`。
 * @param value 左操作数（已转数值）
 * @param fallback 兜底值
 * @return 生效值
 */
internal fun jsNumberOr(value: Double, fallback: Double): Double =
	if (value.isNaN() || value == 0.0) fallback else value

/**
 * 等价 JS 真值判断（用于 `x || ''` 形态）。
 * @param value 任意值
 * @return 是否为 JS 真值
 */
internal fun jsTruthy(value: Any?): Boolean = when (value) {
	null, JsonUndefined -> false
	is Boolean -> value
	is Number -> value.toDouble() != 0.0 && !value.toDouble().isNaN()
	is String -> value.isNotEmpty()
	else -> true
}

/**
 * 等价 JS `String(value)`。
 * @param value 任意值
 * @return 字符串
 */
internal fun jsString(value: Any?): String = when (value) {
	null -> "null"
	JsonUndefined -> "undefined"
	is String -> value
	is Boolean -> if (value) "true" else "false"
	is Number -> io.github.steve02081504.fountp2p.core.Json.jsNumberToString(value.toDouble())
	else -> value.toString()
}

private fun jsStringToNumber(text: String): Double {
	val trimmed = text.trim()
	if (trimmed.isEmpty()) return 0.0
	return when (trimmed) {
		"Infinity", "+Infinity" -> Double.POSITIVE_INFINITY
		"-Infinity" -> Double.NEGATIVE_INFINITY
		"NaN" -> Double.NaN
		else -> {
			val body = trimmed.removePrefix("+")
			when {
				body.length > 2 && body.startsWith("0x", ignoreCase = true) ->
					body.substring(2).toLongOrNull(16)?.toDouble() ?: Double.NaN
				body.length > 2 && body.startsWith("0o", ignoreCase = true) ->
					body.substring(2).toLongOrNull(8)?.toDouble() ?: Double.NaN
				body.length > 2 && body.startsWith("0b", ignoreCase = true) ->
					body.substring(2).toLongOrNull(2)?.toDouble() ?: Double.NaN
				else -> body.toDoubleOrNull() ?: Double.NaN
			}
		}
	}
}
