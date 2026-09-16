package io.github.steve02081504.fountp2p.core

import io.github.steve02081504.fountp2p.crypto.pubKeyHash

/**
 * entityHash 编解码与校验。
 *
 * `encodeEntityHash` / `ENTITY_HASH_RE` / `isEntityHash128` / `parseEntityHash`
 * 定义于 [EntityIdParse]；本文件提供从公钥派生的辅助函数。
 */

/**
 * @param pubKeyHex 32 字节公钥 hex
 * @return 64 位 nodeHash / subjectHash（pubKeyHash）
 */
fun hashFromPubKeyHex(pubKeyHex: Any?): String {
	val hex = isHex64(pubKeyHex) ?: throw IllegalArgumentException("invalid pubKeyHex")
	val bytes = hexToBytes(hex)
	if (bytes.size != 32) throw IllegalArgumentException("invalid pubKeyHex")
	return pubKeyHash(bytes)
}

/**
 * @param nodeHash 成员所属节点 hash
 * @param recoveryPubKeyHex 32 字节 recovery 公钥 hex（稳定身份锚）
 * @return entityHash
 */
fun entityHashFromRecoveryPubKeyHex(nodeHash: String, recoveryPubKeyHex: String): String =
	encodeEntityHash(nodeHash, hashFromPubKeyHex(recoveryPubKeyHex))

/**
 * @param nodeHash 成员所属节点 hash
 * @param subjectHash 成员签名 pubKeyHash（DAG sender）
 * @return entityHash
 */
fun entityHashFromSubjectHash(nodeHash: String, subjectHash: String): String {
	val node = isHex64(nodeHash)
	val subject = isHex64(subjectHash)
	if (node == null || subject == null) throw IllegalArgumentException("invalid subject hash")
	return encodeEntityHash(node, subject)
}
