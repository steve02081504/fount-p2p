package io.github.steve02081504.fountp2p.core

/** 128 位小写 hex：`nodeHash(64)` + `subjectHash(64)`。 */
val ENTITY_HASH_RE = Regex("^[\\da-f]{128}$")

/**
 * @param value 待校验值
 * @return 合法时返回原 128 位实体hash，否则 null（含 0x 前缀/大写/空白）
 */
fun isEntityHash128(value: Any?): String? {
	val text = value as? String ?: return null
	return if (ENTITY_HASH_RE.matches(text)) text else null
}

/** 解析后的 entityHash 分量。 */
data class ParsedEntityHash(val entityHash: String, val nodeHash: String, val subjectHash: String)

/**
 * @param entityHash 128 位 entityHash
 * @return 解析结果；非法时 null
 */
fun parseEntityHash(entityHash: Any?): ParsedEntityHash? {
	val raw = entityHash?.toString() ?: ""
	if (!ENTITY_HASH_RE.matches(raw)) return null
	return ParsedEntityHash(
		entityHash = raw,
		nodeHash = raw.substring(0, 64),
		subjectHash = raw.substring(64, 128),
	)
}

/**
 * @param nodeHash 所属节点（64 hex）
 * @param subjectHash 主体 hash（64 hex）
 * @return 128 位 entityHash
 */
fun encodeEntityHash(nodeHash: Any?, subjectHash: Any?): String {
	val node = isHex64(nodeHash) ?: throw IllegalArgumentException("invalid entity hash parts")
	val subject = isHex64(subjectHash) ?: throw IllegalArgumentException("invalid entity hash parts")
	return node + subject
}
