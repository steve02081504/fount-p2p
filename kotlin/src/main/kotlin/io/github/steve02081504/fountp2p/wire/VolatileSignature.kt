package io.github.steve02081504.fountp2p.wire

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.core.hexToBytes
import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.core.isSignatureHex128
import io.github.steve02081504.fountp2p.crypto.KeyPairBytes
import io.github.steve02081504.fountp2p.crypto.keyPairFromSeed
import io.github.steve02081504.fountp2p.crypto.sha256
import io.github.steve02081504.fountp2p.crypto.sign
import io.github.steve02081504.fountp2p.crypto.verify

/**
 * VOLATILE 流式分片签名域（§6.4）：`pendingStreamId + chunkSeq + slices`。
 *
 * 等价 `js/wire/volatile_signature.mjs`。JS 中 `sign` / `verify` 为异步，
 * 底层 crypto 为纯计算，故此处保持同步（AGENTS：纯 crypto 同步）。
 */

private const val CHUNK_DOMAIN = "fount-volatile-chunk"

/** 入站 stream_chunk 切片数量上限。 */
const val MAX_STREAM_VOLATILE_SLICES = 256

/**
 * @param slices 入站切片
 * @return 合法切片或 null
 */
fun boundStreamSlices(slices: List<Any?>?): List<Any?>? {
	if (slices == null || slices.isEmpty() || slices.size > MAX_STREAM_VOLATILE_SLICES) return null
	return slices
}

/**
 * @param pendingStreamId 逻辑流 id
 * @param chunkSeq 分片序号（从 1 递增）
 * @param slices 差异切片数组
 * @return 验签消息字节
 */
fun streamChunkSignBytes(pendingStreamId: String, chunkSeq: Any?, slices: List<Any?>?): ByteArray {
	val sequence = jsFiniteString(chunkSeq)
	val body = Json.stringify(slices ?: emptyList<Any?>()) ?: "[]"
	return "$CHUNK_DOMAIN\u0000$pendingStreamId\u0000$sequence\u0000$body".toByteArray(Charsets.UTF_8)
}

/**
 * @param bytes 签名域
 * @param secretKey 私钥种子（32 字节）
 * @return 128 位 hex 签名
 */
fun signStreamSignatureHex(bytes: ByteArray, secretKey: ByteArray): String =
	bytesToHex(sign(bytes, secretKey))

/**
 * @param bytes 签名域
 * @param signatureHex 128 位十六进制签名
 * @param publicKeyHex 64 位十六进制公钥
 * @return 验签是否通过
 */
fun verifyStreamSignatureHex(bytes: ByteArray, signatureHex: Any?, publicKeyHex: Any?): Boolean {
	val signature = isSignatureHex128(signatureHex) ?: return false
	val publicKey = isHex64(publicKeyHex) ?: return false
	return try {
		verify(hexToBytes(signature), bytes, hexToBytes(publicKey))
	}
	catch (_: Exception) {
		false
	}
}

/**
 * 本节点出站 VOLATILE 签名密钥（由用户名 + 联邦口令材料确定性派生）。
 * @param username 用户
 * @param seedMaterial 口令或回退材料
 * @return 密钥对
 */
fun streamKeyPairFromUserSeed(username: String, seedMaterial: String): KeyPairBytes {
	val seed = sha256("fount-stream-sign\u0000$username\u0000$seedMaterial")
	return keyPairFromSeed(seed)
}

/**
 * 等价 JS `Number.isFinite(Number(chunkSeq)) ? String(chunkSeq) : '0'`。
 * @param value 序号候选
 * @return JS 风格序号字符串；不可转换或非有限时为 `"0"`
 */
private fun jsFiniteString(value: Any?): String {
	val number = when (value) {
		is Number -> value.toDouble()
		is String -> value.trim().toDoubleOrNull() ?: Double.NaN
		is Boolean -> if (value) 1.0 else 0.0
		null -> 0.0
		else -> Double.NaN
	}
	if (!number.isFinite()) return "0"
	return when (value) {
		is String -> value
		is Boolean -> value.toString()
		is Number -> Json.jsNumberToString(value.toDouble())
		else -> "0"
	}
}
