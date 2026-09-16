package io.github.steve02081504.fountp2p.core

import io.github.steve02081504.fountp2p.crypto.sha256Hex

/** 逻辑实体 sentinel nodeHash（非物理节点绑定） */
const val LOGICAL_ENTITY_SENTINEL_NODE_HASH: String = "0000000000000000000000000000000000000000000000000000000000000000"

/**
 * @param subject 完整 subject 字符串（调用方负责命名空间前缀）
 * @return 128 位 logical entityHash
 */
fun logicalEntityHash(subject: String?): String {
	if (subject.isNullOrEmpty()) throw IllegalArgumentException("subject required")
	return encodeEntityHash(LOGICAL_ENTITY_SENTINEL_NODE_HASH, sha256Hex(subject))
}

/**
 * @param entityHash 128 位十六进制
 * @return 是否为 logical entity（sentinel nodeHash）
 */
fun isLogicalEntityHash(entityHash: Any?): Boolean {
	val parsed = parseEntityHash(entityHash) ?: return false
	return parsed.nodeHash == LOGICAL_ENTITY_SENTINEL_NODE_HASH
}
