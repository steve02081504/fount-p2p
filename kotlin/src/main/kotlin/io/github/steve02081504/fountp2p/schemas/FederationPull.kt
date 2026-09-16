package io.github.steve02081504.fountp2p.schemas

import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.core.isPlainObject
import io.github.steve02081504.fountp2p.core.isSignatureHex128
import io.github.steve02081504.fountp2p.dag.EVENT_ID_HEX

/**
 * 联邦补拉 attestation / ECIES 响应 wire 解析（无 attestation/envelope 即丢弃）。
 */

private const val ENVELOPE_BLOB_MIN_LEN = 2

/**
 * @param value 密文字段
 * @return 是否像合法 ECIES blob 段
 */
private fun isEnvelopeBlob(value: Any?): Boolean = (value?.toString() ?: "").length >= ENVELOPE_BLOB_MIN_LEN

/**
 * @param attestation 载荷 attestation 字段
 * @return 解析结果；非法 null
 */
fun parsePullAttestation(attestation: Any?): Map<String, Any?>? {
	if (!isPlainObject(attestation)) return null
	@Suppress("UNCHECKED_CAST")
	val map = attestation as Map<String, Any?>
	val requesterPubKeyHash = isHex64(map["requesterPubKeyHash"]) ?: return null
	val groupId = (map["groupId"] as? String).orEmpty()
	val requestId = (map["requestId"] as? String).orEmpty()
	val timestamp = io.github.steve02081504.fountp2p.core.Json.num(map["timestamp"])
	val signature = isSignatureHex128(map["signature"]) ?: return null
	if (groupId.isEmpty() || timestamp == null || !timestamp.isFinite()) return null
	val rawWantIds = map["wantIds"] as? List<*>
	val wantIds = if (rawWantIds != null && rawWantIds.isNotEmpty())
		rawWantIds.filterIsInstance<String>().filter { EVENT_ID_HEX.matches(it) }.toSortedSet().toList()
	else
		null
	val out = LinkedHashMap<String, Any?>()
	out["requesterPubKeyHash"] = requesterPubKeyHash
	out["groupId"] = groupId
	out["requestId"] = requestId
	out["timestamp"] = timestamp
	if (wantIds != null) out["wantIds"] = wantIds
	out["signature"] = signature
	return out
}

/**
 * @param envelope 响应 envelope
 * @return 解析结果；非法 null
 */
fun parsePullResponseEnvelope(envelope: Any?): Map<String, Any?>? {
	if (!isPlainObject(envelope)) return null
	@Suppress("UNCHECKED_CAST")
	val map = envelope as Map<String, Any?>
	val requestId = (map["requestId"] as? String).orEmpty()
	val requesterPubKeyHash = isHex64(map["requesterPubKeyHash"]) ?: return null
	val requesterNodeHash = (map["requesterNodeHash"] as? String).orEmpty()
	val ephemPub = (map["ephemPub"] as? String).orEmpty()
	val iv = (map["iv"] as? String).orEmpty()
	val ciphertext = (map["ciphertext"] as? String).orEmpty()
	val authTag = (map["authTag"] as? String).orEmpty()
	if (requestId.isEmpty() || requesterNodeHash.isEmpty()) return null
	if (!isEnvelopeBlob(ephemPub) || !isEnvelopeBlob(iv) || !isEnvelopeBlob(ciphertext) || !isEnvelopeBlob(authTag))
		return null
	return mapOf(
		"requestId" to requestId,
		"requesterPubKeyHash" to requesterPubKeyHash,
		"requesterNodeHash" to requesterNodeHash,
		"ephemPub" to ephemPub,
		"iv" to iv,
		"ciphertext" to ciphertext,
		"authTag" to authTag,
	)
}

/**
 * @param data 入群快照请求载荷
 * @return 解析结果；非法 null
 */
fun parseJoinSnapshotRequest(data: Any?): Map<String, Any?>? {
	if (!isPlainObject(data)) return null
	@Suppress("UNCHECKED_CAST")
	val map = data as Map<String, Any?>
	val requestId = (map["requestId"] as? String).orEmpty()
	val requesterNodeHash = (map["requesterNodeHash"] as? String).orEmpty()
	val groupId = (map["groupId"] as? String).orEmpty()
	val attestation = parsePullAttestation(map["attestation"]) ?: return null
	if (requestId.isEmpty() || requesterNodeHash.isEmpty() || groupId.isEmpty()) return null
	if (attestation["groupId"] != groupId || attestation["requestId"] != requestId) return null
	val tipsHash = (map["tipsHash"] as? String).orEmpty()
	val out = LinkedHashMap<String, Any?>()
	out["requestId"] = requestId
	out["requesterNodeHash"] = requesterNodeHash
	out["requesterPubKeyHash"] = attestation["requesterPubKeyHash"]
	out["groupId"] = groupId
	if (tipsHash.isNotEmpty()) out["tipsHash"] = tipsHash
	out["attestation"] = attestation
	return out
}
