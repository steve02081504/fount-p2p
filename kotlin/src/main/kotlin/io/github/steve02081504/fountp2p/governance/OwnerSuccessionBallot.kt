package io.github.steve02081504.fountp2p.governance

import io.github.steve02081504.fountp2p.core.canonicalStringify
import io.github.steve02081504.fountp2p.core.hexToBytes
import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.core.isSignatureHex128
import io.github.steve02081504.fountp2p.crypto.pubKeyHash
import io.github.steve02081504.fountp2p.crypto.verify

/**
 * 群主继任联署选票验签（§8）：管理员对固定 canonical 载荷签名，达到阈值即通过。
 */

private const val BALLOT_DOMAIN = "fount-owner-succession"

/**
 * @param ballot 选票正文
 * @return 验签消息
 */
fun ownerSuccessionBallotSignBytes(ballot: Map<String, Any?>): ByteArray {
	val body = LinkedHashMap<String, Any?>()
	body["proposedOwnerPubKeyHash"] = ballot["proposedOwnerPubKeyHash"]
	body["groupId"] = ballot["groupId"]
	body["ballotId"] = ballot["ballotId"]
	return "$BALLOT_DOMAIN\u0000${canonicalStringify(body)}".toByteArray(Charsets.UTF_8)
}

/**
 * 校验管理员联署是否达到 `thresholdRatio`（默认半数以上）。
 *
 * JS 侧为 `async`（WebCrypto 异步验签）；JVM 侧 Ed25519 验签为纯同步计算，故此处保持同步。
 * @param ballot 选票正文与签名列表
 * @param adminPubKeyHashes 合法管理员公钥指纹
 * @param thresholdRatio 通过比例 (0,1]
 * @return 达到阈值时为 true
 */
fun verifyOwnerSuccessionThreshold(
	ballot: Map<String, Any?>,
	adminPubKeyHashes: Set<String>,
	thresholdRatio: Any? = 0.5,
): Boolean {
	if (adminPubKeyHashes.isEmpty()) return false

	val ratio = jsNumber(thresholdRatio)
	if (!ratio.isFinite() || ratio <= 0.0 || ratio > 1.0) return false

	val signBytes = ownerSuccessionBallotSignBytes(ballot)
	val needed = Math.ceil(adminPubKeyHashes.size * ratio).toInt()
	val seen = HashSet<String>()
	var valid = 0

	for (entry in ballot["adminSignatures"] as? List<*> ?: emptyList<Any?>()) {
		val signature = entry as? Map<*, *> ?: continue
		val pubKeyHex = isHex64(signature["pubKeyHex"]) ?: continue
		val signatureHex = isSignatureHex128(signature["signature"]) ?: continue

		val hash = pubKeyHash(hexToBytes(pubKeyHex))
		if (hash !in adminPubKeyHashes || hash in seen) continue
		if (!verify(hexToBytes(signatureHex), signBytes, hexToBytes(pubKeyHex))) continue

		seen.add(hash)
		valid++
		if (valid >= needed) return true
	}
	return false
}
