package io.github.steve02081504.fountp2p.crypto

import io.github.steve02081504.fountp2p.core.canonicalStringify
import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.core.hexToBytes
import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.core.isSignatureHex128
import io.github.steve02081504.fountp2p.dag.merkleRoot

/**
 * 为 checkpoint 载荷附加签名（签名字段不包含 `checkpoint_signature` 自身）。
 * @param payload 待签名载荷
 * @param secretKey 32 字节种子私钥
 * @return 带 `checkpoint_signature` 的载荷
 */
fun signCheckpoint(payload: Map<String, Any?>, secretKey: ByteArray): Map<String, Any?> {
	val body = LinkedHashMap(payload)
	body.remove("checkpoint_signature")
	val signature = sign(canonicalStringify(body).toByteArray(Charsets.UTF_8), secretKey)
	val out = LinkedHashMap(payload)
	out["checkpoint_signature"] = bytesToHex(signature)
	return out
}

/**
 * 校验 `checkpoint_signature` 与载荷的一致性。
 * @param checkpoint 完整检查点对象
 * @param ownerPublicKey 32 字节公钥
 * @return 合法为 true
 */
fun verifyCheckpointSignature(checkpoint: Map<String, Any?>, ownerPublicKey: ByteArray): Boolean {
	val raw = isSignatureHex128(checkpoint["checkpoint_signature"]) ?: return false
	val body = LinkedHashMap(checkpoint)
	body.remove("checkpoint_signature")
	val messageBytes = canonicalStringify(body).toByteArray(Charsets.UTF_8)
	return verify(hexToBytes(raw), messageBytes, ownerPublicKey)
}

/**
 * 判断 checkpoint 是否带合法 Ed25519 签名。
 * @param checkpoint checkpoint 对象
 * @return 签名格式合法为 true
 */
fun isSignedCheckpoint(checkpoint: Any?): Boolean =
	isSignatureHex128((checkpoint as? Map<*, *>)?.get("checkpoint_signature")) != null

/** verifyRemoteCheckpoint 结果。 */
data class CheckpointVerifyResult(val valid: Boolean, val reason: String? = null) {
	/** @return JSON 可序列化对象（`reason` 缺省时省略） */
	fun toJson(): Map<String, Any?> = if (reason == null) mapOf("valid" to valid) else mapOf("valid" to valid, "reason" to reason)
}

/**
 * 校验远端 checkpoint 的结构、Merkle 根与 delegated owner 签名。
 * @param checkpoint checkpoint 对象
 * @return 校验结果；`valid` 为 false 时 `reason` 说明原因
 */
fun verifyRemoteCheckpoint(checkpoint: Any?): CheckpointVerifyResult {
	val map = checkpoint as? Map<*, *>
		?: return CheckpointVerifyResult(false, "checkpoint missing or not an object")
	val epochIds = map["eventIdsInEpoch"] as? List<*>
	if (epochIds.isNullOrEmpty())
		return CheckpointVerifyResult(false, "eventIdsInEpoch missing or empty")
	val root = merkleRoot(epochIds.mapNotNull { it as? String })
	if (map["epoch_root_hash"] != root)
		return CheckpointVerifyResult(false, "epoch_root_hash does not match Merkle root of eventIdsInEpoch")
	val membersRecord = map["members_record"] as? Map<*, *>
	val ownerHash = membersRecord?.get("delegatedOwnerPubKeyHash")
	val members = membersRecord?.get("members") as? Map<*, *>
	val owner = members?.get(ownerHash) as? Map<*, *>
	val pubHex = owner?.get("pubKeyHex")
	if (isHex64(pubHex) == null)
		return CheckpointVerifyResult(false, "delegated owner pubkey missing")
	@Suppress("UNCHECKED_CAST")
	val checkpointMap = map as Map<String, Any?>
	if (!verifyCheckpointSignature(checkpointMap, hexToBytes(pubHex as String)))
		return CheckpointVerifyResult(false, "checkpoint signature invalid")
	return CheckpointVerifyResult(true)
}
