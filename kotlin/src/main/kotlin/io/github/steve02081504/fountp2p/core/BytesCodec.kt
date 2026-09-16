package io.github.steve02081504.fountp2p.core

import java.util.Base64

/**
 * Base64 / hex / bytes 互转（无平台依赖，JVM 与 Android 共用）。
 */
private const val HEX_DIGITS = "0123456789abcdef"

/**
 * @param bytes 原始字节
 * @return 小写 hex
 */
fun bytesToHex(bytes: ByteArray): String {
	val out = StringBuilder(bytes.size * 2)
	for (byte in bytes) {
		val value = byte.toInt() and 0xff
		out.append(HEX_DIGITS[value ushr 4]).append(HEX_DIGITS[value and 15])
	}
	return out.toString()
}

private fun hexNibble(code: Int): Int = when (code) {
	in 48..57 -> code - 48
	in 97..102 -> code - 87
	in 65..70 -> code - 55
	else -> -1
}

/**
 * @param hex hex 文本（偶数字符；大小写均可）
 * @return 解码后的字节
 */
fun hexToBytes(hex: String): ByteArray {
	if (hex.length % 2 != 0) throw IllegalArgumentException("p2p: hex length must be even")
	val out = ByteArray(hex.length / 2)
	for (index in out.indices) {
		val high = hexNibble(hex[index * 2].code)
		val low = hexNibble(hex[index * 2 + 1].code)
		if (high < 0 || low < 0) throw IllegalArgumentException("p2p: invalid hex")
		out[index] = ((high shl 4) or low).toByte()
	}
	return out
}

/**
 * 转换为字节；[allowString] 时把非字节输入当 UTF-8 文本编码。
 * @param value 待转换值
 * @param allowString 是否接受字符串
 * @return 字节
 */
fun toBytes(value: Any?, allowString: Boolean = false): ByteArray {
	if (value is ByteArray) return value
	if (allowString) return (value as? String ?: value?.toString() ?: "").toByteArray(Charsets.UTF_8)
	throw IllegalArgumentException("p2p: bytes must be Uint8Array-compatible")
}

/**
 * @param bytes 原始字节
 * @return 标准 Base64
 */
fun bytesToBase64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

/**
 * @param base64 标准 Base64
 * @return 解码后的字节
 */
fun base64ToBytes(base64: String): ByteArray = Base64.getDecoder().decode(base64)
