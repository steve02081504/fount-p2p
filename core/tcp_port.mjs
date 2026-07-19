/**
 * 规范化 TCP 端口（advert / peer hint 共用）。
 * @param {unknown} port 原始端口
 * @returns {number | null} 有效端口或 null（未提供 / 非法）
 */
export function normalizeTcpPort(port) {
	if (port == null || port === '') return null
	const value = Number(port)
	if (!Number.isInteger(value) || value < 1 || value > 65535) return null
	return value
}
