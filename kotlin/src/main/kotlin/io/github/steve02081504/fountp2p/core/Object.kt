package io.github.steve02081504.fountp2p.core

/**
 * 判定 `{}` 形态对象。
 *
 * 在 Kotlin 中 JSON 对象即 [JsonObject]（键为 String 的 Map）；本函数排除
 * 非 String 键的 Map 与数组。
 * @param value 待判定值
 * @return 是否为普通 JSON 对象
 */
fun isPlainObject(value: Any?): Boolean {
	if (value !is Map<*, *>) return false
	for (key in value.keys) if (key !is String) return false
	return true
}
