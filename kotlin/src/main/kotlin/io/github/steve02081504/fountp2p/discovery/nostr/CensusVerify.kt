package io.github.steve02081504.fountp2p.discovery.nostr

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.hexToBytes
import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.core.isSignatureHex128
import io.github.steve02081504.fountp2p.crypto.pubKeyHash
import io.github.steve02081504.fountp2p.crypto.verify

/** 事件/窗口存活时间（与 advert TTL 一致）。 */
const val CENSUS_TTL_MS: Long = 10L * 60_000

private fun jsNumber(value: Any?): String =
	Json.jsNumberToString((value as? Number)?.toDouble() ?: Double.NaN)

/**
 * @param ts 时间戳（毫秒）
 * @param nodeHash 64 hex 节点 hash
 * @param p 包含概率
 * @return 待签名消息
 */
fun buildCensusMessage(ts: Any?, nodeHash: String, p: Any?): ByteArray =
	"fount-census\u0000${jsNumber(ts)}\u0000$nodeHash\u0000${jsNumber(p)}".toByteArray(Charsets.UTF_8)

/** census 校验结果。 */
data class VerifiedCensus(val nodeHash: String, val p: Double, val ts: Double) {
	/** @return 等价 JS 普通对象 `{ nodeHash, p, ts }` */
	fun toJson(): Map<String, Any?> = linkedMapOf("nodeHash" to nodeHash, "p" to p, "ts" to ts)
}

/**
 * 校验 census 包（Untrusted ingress）：canonicalize + 验签 + 时间窗 + p 范围。
 * @param packet 原始 census 包
 * @param now 当前时间（毫秒）
 * @param ttlMs 允许的时间窗
 * @return 校验通过返回结果，否则 null
 */
@JvmOverloads
fun verifyCensusPacket(packet: Any?, now: Long = System.currentTimeMillis(), ttlMs: Long = CENSUS_TTL_MS): VerifiedCensus? {
	val obj = packet as? Map<*, *> ?: return null
	val nodeHash = isHex64(obj["nodeHash"]) ?: return null
	val nodePubKey = isHex64(obj["nodePubKey"]) ?: return null
	val sig = isSignatureHex128(obj["sig"]) ?: return null
	val ts = (obj["ts"] as? Number)?.toDouble() ?: return null
	if (ts.isNaN() || ts.isInfinite()) return null
	if (kotlin.math.abs(now - ts) > ttlMs) return null
	val p = (obj["p"] as? Number)?.toDouble() ?: return null
	if (p.isNaN() || p.isInfinite() || p < CENSUS_MIN_P || p > 1.0) return null
	try {
		if (pubKeyHash(hexToBytes(nodePubKey)) != nodeHash) return null
	}
	catch (_: Exception) {
		return null
	}
	val message = buildCensusMessage(ts, nodeHash, p)
	return if (verify(hexToBytes(sig), message, hexToBytes(nodePubKey))) VerifiedCensus(nodeHash, p, ts) else null
}

/**
 * 解 content 字节并校验 census 包。
 * @param bytes content 解码字节
 * @param now 当前时间（毫秒）
 * @param ttlMs 允许的时间窗
 * @return 校验通过结果或 null
 */
@JvmOverloads
fun verifyCensusBytes(bytes: ByteArray, now: Long = System.currentTimeMillis(), ttlMs: Long = CENSUS_TTL_MS): VerifiedCensus? =
	try {
		verifyCensusPacket(Json.parse(String(bytes, Charsets.UTF_8)), now, ttlMs)
	}
	catch (_: Exception) {
		null
	}
