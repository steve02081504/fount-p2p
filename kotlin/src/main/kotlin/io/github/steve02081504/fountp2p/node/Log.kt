package io.github.steve02081504.fountp2p.node

import io.github.steve02081504.fountp2p.core.JsonUndefined

/** 连接/发现诊断日志开关。 */
private var connectivityDebug = false

/** @param enabled 是否输出连接诊断 */
fun setConnectivityDebug(enabled: Boolean) {
	connectivityDebug = enabled
}

/** @return 当前是否输出连接诊断 */
fun isConnectivityDebug(): Boolean = connectivityDebug

/**
 * 缩短 nodeHash 便于对照两边日志。
 * @param hash 完整 hash
 * @param n 前缀长度
 * @return 短 hash
 */
fun shortHash(hash: String?, n: Int = 8): String {
	val value = hash ?: ""
	return if (value.length <= n) value else value.substring(0, n)
}

/**
 * 连接诊断 info（未开启或无 logger 时静默）。
 * @param message 消息
 * @param extra 附加字段
 */
fun nodeDebug(message: String, extra: Any? = JsonUndefined) {
	if (!connectivityDebug) return
	val logger = getNodeLogger() ?: return
	if (extra === JsonUndefined) logger.info(message) else logger.info(message, extra)
}

/** 测试专用：关掉连接诊断。 */
fun resetConnectivityDebugForTests() {
	connectivityDebug = false
}
