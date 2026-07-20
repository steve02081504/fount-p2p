/**
 * Base64 / hex / bytes 互转（无 Node 依赖，浏览器与 Node 共用）。
 */

const HEX = '0123456789abcdef'

/**
 * @param {number} code UTF-16 码元（期望为 0-9 / a-f / A-F）
 * @returns {number} 0–15；非法为 -1
 */
function hexNibble(code) {
	if (code >= 48 && code <= 57) return code - 48
	if (code >= 97 && code <= 102) return code - 87
	if (code >= 65 && code <= 70) return code - 55
	return -1
}

/**
 * @param {Uint8Array} bytes 原始字节
 * @returns {string} 小写 hex
 */
export function bytesToHex(bytes) {
	let out = ''
	for (let index = 0; index < bytes.length; index++) {
		const byte = bytes[index]
		out += HEX[byte >> 4] + HEX[byte & 15]
	}
	return out
}

/**
 * @param {string} hex hex 文本（可含空白；大小写不敏感）
 * @returns {Uint8Array} 解码后的字节
 */
export function hexToBytes(hex) {
	const text = hex.trim().toLowerCase()
	if (text.length % 2) throw new Error('p2p: hex length must be even')
	const out = new Uint8Array(text.length / 2)
	for (let index = 0; index < out.length; index++) {
		const high = hexNibble(text.charCodeAt(index * 2))
		const low = hexNibble(text.charCodeAt(index * 2 + 1))
		if (high < 0 || low < 0) throw new Error('p2p: invalid hex')
		out[index] = (high << 4) | low
	}
	return out
}

/**
 * ArrayBuffer / TypedArray / Uint8Array → Uint8Array；`allowString` 时接受文本。
 * @param {unknown} value 待转换值
 * @param {{ allowString?: boolean }} [options] `allowString` 时把非字节输入当文本编码
 * @returns {Uint8Array} 字节视图（可能与输入共享底层 buffer）
 */
export function toBytes(value, options = {}) {
	if (value instanceof Uint8Array) return value
	if (value instanceof ArrayBuffer) return new Uint8Array(value)
	if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
	if (options.allowString)
		return new TextEncoder().encode(typeof value === 'string' ? value : String(value ?? ''))
	throw new Error('p2p: bytes must be Uint8Array-compatible')
}

/**
 * @param {Uint8Array} bytes 原始字节
 * @returns {string} 标准 Base64
 */
export function bytesToBase64(bytes) {
	let binary = ''
	for (let index = 0; index < bytes.length; index++) binary += String.fromCharCode(bytes[index])
	return btoa(binary)
}

/**
 * @param {string} base64 标准 Base64
 * @returns {Uint8Array} 解码后的字节
 */
export function base64ToBytes(base64) {
	return Uint8Array.from(atob(base64), char => char.charCodeAt(0))
}
