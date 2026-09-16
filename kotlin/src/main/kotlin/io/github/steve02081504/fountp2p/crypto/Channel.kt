package io.github.steve02081504.fountp2p.crypto

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.base64ToBytes
import io.github.steve02081504.fountp2p.core.bytesToBase64
import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.core.hexToBytes
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Domain-key 信封：AES-GCM 消息载荷（wire scheme：channel-key）。
 * 解密 payload 不可脱离外层 DAG Ed25519 签名上下文单独传递或信任。
 */

/** 频道消息 content 加密 scheme */
const val CHANNEL_KEY_SCHEME = "channel-key"

/**
 * @return 32 字节 hex 频道密钥
 */
fun generateChannelKey(): String = bytesToHex(randomBytes(32))

private const val AES_GCM_TAG_BYTES = 16

/** HKDF-SHA256（等价 Node `hkdfSync('sha256', ikm, salt, info, length)`）。 */
internal fun hkdfSha256(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
	val mac = Mac.getInstance("HmacSHA256")
	val effectiveSalt = if (salt.isEmpty()) ByteArray(32) else salt
	mac.init(SecretKeySpec(effectiveSalt, "HmacSHA256"))
	val prk = mac.doFinal(ikm)
	mac.init(SecretKeySpec(prk, "HmacSHA256"))
	val okm = ByteArray(length)
	var previous = ByteArray(0)
	var generated = 0
	var counter = 1
	while (generated < length) {
		mac.update(previous)
		mac.update(info)
		mac.update(counter.toByte())
		previous = mac.doFinal()
		val take = minOf(previous.size, length - generated)
		System.arraycopy(previous, 0, okm, generated, take)
		generated += take
		counter++
	}
	return okm
}

/** AES-256-GCM 加密，返回 `ciphertext || authTag` 拼接。 */
internal fun aesGcmEncrypt(key: ByteArray, iv: ByteArray, plaintext: ByteArray): ByteArray {
	val cipher = Cipher.getInstance("AES/GCM/NoPadding")
	cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
	return cipher.doFinal(plaintext)
}

/** AES-256-GCM 解密 `ciphertext || authTag`；失败返回 null。 */
internal fun aesGcmDecrypt(key: ByteArray, iv: ByteArray, ciphertextWithTag: ByteArray): ByteArray? = try {
	val cipher = Cipher.getInstance("AES/GCM/NoPadding")
	cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
	cipher.doFinal(ciphertextWithTag)
}
catch (_: Exception) {
	null
}

/**
 * @param channelKeyHex K_ch
 * @param channelId 频道 id（AAD 盐）
 * @param generation 代际
 * @return 消息 AES-256 密钥
 */
private fun messageAesKey(channelKeyHex: String, channelId: String, generation: Int): ByteArray =
	hkdfSha256(
		hexToBytes(channelKeyHex),
		"$CHANNEL_KEY_SCHEME:$channelId:$generation".toByteArray(Charsets.UTF_8),
		ByteArray(0),
		32,
	)

/**
 * @param plaintext UTF-8 / JSON 字符串
 * @param channelKeyHex K_ch
 * @param channelId 频道 ID
 * @param generation 密钥代际
 * @return 频道密钥信封
 */
fun encryptWithChannelKey(plaintext: String, channelKeyHex: String, channelId: String, generation: Int): Map<String, Any?> =
	encryptWithChannelKey(plaintext.toByteArray(Charsets.UTF_8), channelKeyHex, channelId, generation)

/**
 * @param plaintext 明文字节
 * @param channelKeyHex K_ch
 * @param channelId 频道 ID
 * @param generation 密钥代际
 * @return 频道密钥信封
 */
fun encryptWithChannelKey(plaintext: ByteArray, channelKeyHex: String, channelId: String, generation: Int): Map<String, Any?> {
	val key = messageAesKey(channelKeyHex, channelId, generation)
	val iv = randomBytes(12)
	val sealed = aesGcmEncrypt(key, iv, plaintext)
	val ciphertext = sealed.copyOfRange(0, sealed.size - AES_GCM_TAG_BYTES)
	val authTag = sealed.copyOfRange(sealed.size - AES_GCM_TAG_BYTES, sealed.size)
	return Json.jsonOf(
		"scheme" to CHANNEL_KEY_SCHEME,
		"channelId" to channelId,
		"generation" to generation,
		"payload" to "${bytesToBase64(iv)}.${bytesToBase64(ciphertext)}.${bytesToBase64(authTag)}",
	)
}

/**
 * @param envelope 频道密钥信封
 * @param channelKeyHex K_ch
 * @param channelId 频道 ID
 * @return 明文 UTF-8；失败 null
 */
fun decryptWithChannelKey(envelope: Any?, channelKeyHex: String, channelId: String): String? {
	val map = envelope as? Map<*, *> ?: return null
	if (map["scheme"] != CHANNEL_KEY_SCHEME) return null
	val payload = map["payload"] as? String ?: return null
	if (payload.isEmpty()) return null
	try {
		val parts = payload.split('.')
		if (parts.size != 3) return null
		val generation = Json.int(map["generation"]) ?: 0
		val key = messageAesKey(channelKeyHex, channelId, generation)
		val iv = base64ToBytes(parts[0])
		val ciphertext = base64ToBytes(parts[1])
		val authTag = base64ToBytes(parts[2])
		val plain = aesGcmDecrypt(key, iv, ciphertext + authTag) ?: return null
		return String(plain, Charsets.UTF_8)
	}
	catch (_: Exception) {
		return null
	}
}
