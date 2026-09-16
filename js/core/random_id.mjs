/**
 * 跨端随机 ID（Web Crypto / Node globalThis.crypto）。
 */

/**
 * @param {string} prefix ID 前缀（如 channel_）
 * @returns {string} 带前缀的随机 ID
 */
export function prefixedRandomId(prefix) {
	return `${prefix}${globalThis.crypto.randomUUID().replace(/-/g, '')}`
}
