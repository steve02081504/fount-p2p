package io.github.steve02081504.fountp2p.schemas

import io.github.steve02081504.fountp2p.core.isHex64

/** mailbox wire 校验结果。 */
sealed class MailboxWireResult {
	/** 校验通过，携带规范化值。 */
	data class Ok(val value: String) : MailboxWireResult()

	/** 校验失败。 */
	data class Err(val code: String, val field: String) : MailboxWireResult()
}

/** mailbox record 形状校验结果。 */
sealed class MailboxRecordShapeResult {
	/** 校验通过。 */
	data class Ok(val value: Map<String, Any?>) : MailboxRecordShapeResult()

	/** 校验失败。 */
	data class Err(val code: String, val field: String) : MailboxRecordShapeResult()
}

/**
 * @param value 收件人 pubKeyHash
 * @return 规范化 hex64 或结构化错误
 */
fun assertMailboxPubKeyHash(value: Any?): MailboxWireResult {
	val normalized = isHex64(value)
	if (normalized == null) return MailboxWireResult.Err("invalid_hex64", "toPubKeyHash")
	return MailboxWireResult.Ok(normalized)
}

/**
 * @param record mailbox 记录
 * @return 已校验的 record 或结构化错误
 */
fun assertMailboxRecordShape(record: Any?): MailboxRecordShapeResult {
	if (record !is Map<*, *> || record.keys.any { it !is String })
		return MailboxRecordShapeResult.Err("required", "record")
	@Suppress("UNCHECKED_CAST")
	val map = record as Map<String, Any?>
	val pubKey = assertMailboxPubKeyHash(map["toPubKeyHash"])
	if (pubKey is MailboxWireResult.Err)
		return MailboxRecordShapeResult.Err(pubKey.code, "record.toPubKeyHash")
	return MailboxRecordShapeResult.Ok(map)
}
