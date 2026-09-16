package io.github.steve02081504.fountp2p.core

/**
 * 规范化 TCP 端口（advert / peer hint 共用）。
 * @param port 原始端口
 * @return 有效端口或 null（未提供 / 非法）
 */
fun normalizeTcpPort(port: Any?): Int? {
	if (port == null) return null
	val value = when (port) {
		is Boolean -> return null
		is Number -> port.toDouble()
		is String -> port.toDoubleOrNull() ?: return null
		else -> return null
	}
	if (value.isNaN() || value.isInfinite()) return null
	if (value % 1.0 != 0.0) return null
	if (value < 1 || value > 65535) return null
	return value.toInt()
}
