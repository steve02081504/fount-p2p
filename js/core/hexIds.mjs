/** 64 位小写十六进制（DAG 事件 id、公钥哈希等）。 */
export const HEX_ID_64 = /^[\da-f]{64}$/u

/** 签名 hex（128 字符）。 */
export const SIGNATURE_HEX_128 = /^[\da-f]{128}$/u

/** `blob:<64hex>` 存储定位符。 */
export const BLOB_STORAGE_LOCATOR_RE = /^blob:([\da-f]{64})$/u

/** `local:…/chunks/<64hex>.bin` 群分块路径。 */
export const LOCAL_CHUNK_FILE_RE = /^local:[^/]+\/chunks\/([\da-f]{64})\.bin$/u

/**
 * @param {unknown} value 待校验值
 * @returns {string | null} 合法时返回原 64 位 hex，否则 null（含 0x 前缀/大写/空白）
 */
export function isHex64(value) {
	return HEX_ID_64.test(value) ? value : null
}

/**
 * 64 位 hex eventId 字典序比较（固定宽度 ASCII，不用 localeCompare）。
 * @param {unknown} a 左操作数
 * @param {unknown} b 右操作数
 * @returns {number} 排序比较结果
 */
export function compareHex64Asc(a, b) {
	return a < b ? -1 : a > b ? 1 : 0
}

/**
 * 外部入站专用：断言小写 64 位 hex（不清理 0x 前缀，直接拒绝）。
 * @param {unknown} value 原始值
 * @param {string} [label='hex64'] 字段名（错误信息）
 * @returns {string} 小写 64 位 hex
 */
export function assertHex64(value, label = 'hex64') {
	if (!HEX_ID_64.test(value))
		throw new Error(`${label} must be 64 hex characters`)
	return value
}

/**
 * @param {unknown} value 待校验值
 * @returns {string | null} 合法时返回 128 位签名 hex，否则 null
 */
export function isSignatureHex128(value) {
	const normalized = String(value ?? '')
	return SIGNATURE_HEX_128.test(normalized) ? normalized : null
}
