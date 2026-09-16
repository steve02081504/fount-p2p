package io.github.steve02081504.fountp2p.utils

/**
 * 将持续时间字符串转换为毫秒。
 * @param duration 持续时间字符串 (例如, "1d", "2h", "30m", "10s") 或毫秒数
 * @return 持续时间（以毫秒为单位）
 */
fun ms(duration: Any?): Long {
	if (duration is Number) return duration.toLong()
	val text = duration as? String ?: throw IllegalArgumentException("Invalid duration format")
	val match = Regex("(\\d+)\\s*(\\w+)").find(text)
		?: throw IllegalArgumentException("Invalid duration format")
	val value = match.groupValues[1].toLong()
	return when (match.groupValues[2]) {
		"s" -> value * 1000
		"m" -> value * 60 * 1000
		"h" -> value * 60 * 60 * 1000
		"d" -> value * 24 * 60 * 60 * 1000
		else -> throw IllegalArgumentException("Invalid duration unit")
	}
}
