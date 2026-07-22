import { getNodeLogger } from './instance.mjs'

/**
 * 连接/发现诊断日志开关。
 * CLI（非 --quiet）默认打开；非 CLI 用 `setConnectivityDebug(true)`。
 * @type {boolean}
 */
let connectivityDebug = false

/**
 * @param {boolean} enabled 是否输出连接诊断
 * @returns {void}
 */
export function setConnectivityDebug(enabled) {
	connectivityDebug = !!enabled
}

/**
 * @returns {boolean} 当前是否输出连接诊断
 */
export function isConnectivityDebug() {
	return connectivityDebug
}

/**
 * 缩短 nodeHash 便于对照两边日志。
 * @param {string | null | undefined} hash 完整 hash
 * @param {number} [n=8] 前缀长度
 * @returns {string} 短 hash
 */
export function shortHash(hash, n = 8) {
	const value = String(hash || '')
	return value.length <= n ? value : value.slice(0, n)
}

/**
 * 连接诊断 info（未开启或无 logger 时静默）。
 * @param {string} message 消息
 * @param {object} [extra] 附加字段
 * @returns {void}
 */
export function nodeDebug(message, extra) {
	if (!connectivityDebug) return
	const logger = getNodeLogger()
	if (!logger?.info) return
	if (extra === undefined) logger.info(message)
	else logger.info(message, extra)
}

/**
 * 测试专用：关掉连接诊断。
 * @returns {void}
 */
export function resetConnectivityDebugForTests() {
	connectivityDebug = false
}
