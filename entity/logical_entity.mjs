import { encodeEntityHash, parseEntityHash } from '../core/entity_id.mjs'
import { sha256TextHex } from '../crypto/crypto.mjs'

/** @type {string} 逻辑实体 sentinel nodeHash（非物理节点绑定） */
export const LOGICAL_ENTITY_SENTINEL_NODE_HASH = '0'.repeat(64)

/**
 * @param {string} subject 完整 subject 字符串（调用方负责命名空间前缀）
 * @returns {string} 128 位 logical entityHash
 */
export function logicalEntityHash(subject) {
	const s = String(subject || '').trim()
	if (!s) throw new Error('subject required')
	return encodeEntityHash(LOGICAL_ENTITY_SENTINEL_NODE_HASH, sha256TextHex(s))
}

/**
 * @param {unknown} entityHash 128 位十六进制
 * @returns {boolean} 是否为 logical entity（sentinel nodeHash）
 */
export function isLogicalEntityHash(entityHash) {
	const parsed = parseEntityHash(entityHash)
	if (!parsed) return false
	return parsed.nodeHash === LOGICAL_ENTITY_SENTINEL_NODE_HASH
}
