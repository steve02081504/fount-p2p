package io.github.steve02081504.fountp2p.mailbox

import io.github.steve02081504.fountp2p.core.assertHex64
import io.github.steve02081504.fountp2p.core.isPlainObject
import io.github.steve02081504.fountp2p.federation.jsString
import io.github.steve02081504.fountp2p.federation.jsTruthy
import io.github.steve02081504.fountp2p.schemas.MailboxRecordShapeResult
import io.github.steve02081504.fountp2p.schemas.MailboxWireResult
import io.github.steve02081504.fountp2p.schemas.assertMailboxPubKeyHash
import io.github.steve02081504.fountp2p.schemas.assertMailboxRecordShape

/**
 * Mailbox wire 载荷解析。
 *
 * 等价 `js/mailbox/parse.mjs`。
 */

/** mailbox 解析结果（等价 JS `{ ok: true, value } | { ok: false, code, field }`）。 */
sealed class MailboxParseResult {
	/** 是否解析成功。 */
	abstract val ok: Boolean

	/** 解析成功，携带规范化载荷（保持 JS 键序）。 */
	data class Ok(val value: Map<String, Any?>) : MailboxParseResult() {
		override val ok: Boolean get() = true
	}

	/** 解析失败。 */
	data class Err(val code: String, val field: String) : MailboxParseResult() {
		override val ok: Boolean get() = false
	}
}

/**
 * @param payload 载荷
 * @return 解析结果
 */
fun parseMailboxPut(payload: Any?): MailboxParseResult {
	if (!isPlainObject(payload))
		return MailboxParseResult.Err("invalid_payload", "payload")
	@Suppress("UNCHECKED_CAST")
	val map = payload as Map<String, Any?>
	if (!isPlainObject(map["record"]))
		return MailboxParseResult.Err("required", "record")
	when (val shape = assertMailboxRecordShape(map["record"])) {
		is MailboxRecordShapeResult.Err -> return MailboxParseResult.Err(shape.code, shape.field)
		is MailboxRecordShapeResult.Ok -> Unit
	}
	val nodeHash = map["nodeHash"]
	if (nodeHash != null)
		try {
			assertHex64(nodeHash, "mailbox_put.nodeHash")
		}
		catch (_: Exception) {
			return MailboxParseResult.Err("invalid_hex64", "nodeHash")
		}

	return MailboxParseResult.Ok(map)
}

/**
 * @param payload 载荷
 * @return 解析结果
 */
fun parseMailboxWant(payload: Any?): MailboxParseResult {
	if (!isPlainObject(payload))
		return MailboxParseResult.Err("invalid_payload", "payload")
	@Suppress("UNCHECKED_CAST")
	val map = payload as Map<String, Any?>
	val pubKey = assertMailboxPubKeyHash(map["toPubKeyHash"])
	if (pubKey !is MailboxWireResult.Ok)
		return MailboxParseResult.Err((pubKey as MailboxWireResult.Err).code, "toPubKeyHash")
	val normalized = LinkedHashMap(map)
	normalized["toPubKeyHash"] = pubKey.value
	return MailboxParseResult.Ok(normalized)
}

/**
 * @param payload 载荷
 * @return 解析结果
 */
fun parseMailboxGive(payload: Any?): MailboxParseResult {
	if (!isPlainObject(payload))
		return MailboxParseResult.Err("invalid_payload", "payload")
	@Suppress("UNCHECKED_CAST")
	val map = payload as Map<String, Any?>
	val rawRecords = map["records"]
	if (rawRecords !is List<*>)
		return MailboxParseResult.Err("required", "records")
	val records = ArrayList<Map<String, Any?>>()
	for (index in rawRecords.indices) {
		@Suppress("UNCHECKED_CAST")
		val record = rawRecords[index] as? Map<String, Any?>
			?: return MailboxParseResult.Err("required", "records[$index].record")
		when (val shape = assertMailboxRecordShape(record)) {
			is MailboxRecordShapeResult.Err ->
				return MailboxParseResult.Err(shape.code, "records[$index].${shape.field}")
			is MailboxRecordShapeResult.Ok -> Unit
		}
		if (!isPlainObject(record["envelope"]))
			return MailboxParseResult.Err("required", "records[$index].envelope")
		val app = record["app"]
		val appText = if (jsTruthy(app)) jsString(app) else ""
		if (appText.isEmpty())
			return MailboxParseResult.Err("required", "records[$index].app")
		records.add(record)
	}
	val normalized = LinkedHashMap(map)
	normalized["records"] = records
	return MailboxParseResult.Ok(normalized)
}
