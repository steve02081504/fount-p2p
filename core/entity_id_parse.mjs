import { isHex64 } from './hexIds.mjs'

/** 128 位小写 hex：`nodeHash(64)` + `subjectHash(64)`。 */
export const ENTITY_HASH_RE = /^[\da-f]{128}$/u

/**
 * @param {unknown} value 待校验值
 * @returns {string | null} 合法时返回原 128 位实体hash，否则 null（含 0x 前缀/大写/空白）
 */
export function isEntityHash128(value) {
	return ENTITY_HASH_RE.test(value) ? value : null
}

/**
 * @param {unknown} entityHash 128 位 entityHash
 * @returns {{ entityHash: string, nodeHash: string, subjectHash: string } | null} 解析结果；非法时 null
 */
export function parseEntityHash(entityHash) {
	const raw = String(entityHash ?? '')
	if (!ENTITY_HASH_RE.test(raw)) return null
	return {
		entityHash: raw,
		nodeHash: raw.slice(0, 64),
		subjectHash: raw.slice(64, 128),
	}
}

/**
 * @param {string} nodeHash 所属节点（64 hex）
 * @param {string} subjectHash 主体 hash（64 hex）
 * @returns {string} 128 位 entityHash
 */
export function encodeEntityHash(nodeHash, subjectHash) {
	const node = isHex64(nodeHash)
	const subject = isHex64(subjectHash)
	if (!node || !subject)
		throw new Error('invalid entity hash parts')
	return node + subject
}
