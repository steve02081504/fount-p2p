/**
 * Base64 / hex / bytes 互转（无 Node 依赖，浏览器与 Node 共用）。
 */

/**
 * @param {Uint8Array} u8 原始字节
 * @returns {string} 标准 Base64 文本
 */
export function u8ToB64(u8) {
	let binary = ''
	for (let index = 0; index < u8.length; index++) binary += String.fromCharCode(u8[index])
	return btoa(binary)
}

/**
 * @param {string} b64 标准 Base64 文本
 * @returns {Uint8Array} 解码后的字节
 */
export function b64ToU8(b64) {
	const bin = atob(b64)
	const out = new Uint8Array(bin.length)
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
	return out
}
