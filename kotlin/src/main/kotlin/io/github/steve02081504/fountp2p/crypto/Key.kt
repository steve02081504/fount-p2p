package io.github.steve02081504.fountp2p.crypto

import io.github.steve02081504.fountp2p.core.base64ToBytes
import io.github.steve02081504.fountp2p.core.bytesToBase64
import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.core.hexToBytes
import io.github.steve02081504.fountp2p.utils.LruMap
import org.bouncycastle.math.ec.rfc7748.X25519
import java.math.BigInteger
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * 群/实体主密钥 KDF 与 ECIES 封装（频道 K_ch、fileMasterKey、vault master key）。
 */

// ─── KDF ──────────────────────────────────────────────────────────────────────

private const val KDF_CACHE_MAX = 512

private val kdfCache = LruMap<String, ByteArray>(KDF_CACHE_MAX)

/** 清空 KDF 派生缓存（H 轮换后调用）。 */
fun clearMasterKeyKdfCache() = kdfCache.clear()

private fun kdfCacheKey(h: ByteArray, label: String, id: String): String =
	"${bytesToHex(h)}:$label:$id"

/** HMAC-SHA256(key=H, data=label + "\x00" + id) → 32 字节 AES-256 密钥。 */
private fun kdf(h: ByteArray, label: String, id: String): ByteArray {
	val cacheKey = kdfCacheKey(h, label, id)
	val cached = kdfCache.get(cacheKey)
	if (cached != null) {
		kdfCache.touch(cacheKey, cached)
		return cached.copyOf()
	}
	val mac = Mac.getInstance("HmacSHA256")
	mac.init(SecretKeySpec(h, "HmacSHA256"))
	mac.update(label.toByteArray(Charsets.UTF_8))
	mac.update(0)
	mac.update(id.toByteArray(Charsets.UTF_8))
	val derived = mac.doFinal()
	kdfCache.touch(cacheKey, derived.copyOf())
	return derived
}

private fun toHBuf(h: Any?): ByteArray = when (h) {
	is String -> hexToBytes(h)
	is ByteArray -> h
	else -> throw IllegalArgumentException("p2p: H must be hex string or bytes")
}

// ─── 密钥推导 ─────────────────────────────────────────────────────────────────

/** 推导群文件加密密钥：`KDF(H, "file", fileId)`。 */
fun deriveFileKey(h: Any?, fileId: String): ByteArray = kdf(toHBuf(h), "file", fileId)

/** 推导 social 帖子加密密钥：`KDF(H, "post", postId)`。 */
fun deriveSocialPostKey(h: Any?, postId: String): ByteArray = kdf(toHBuf(h), "post", postId)

/** 推导流媒体观看令牌 HMAC 密钥：`KDF(H, "streaming", groupId)`。 */
fun deriveStreamingAuthKey(h: Any?, groupId: String): ByteArray = kdf(toHBuf(h), "streaming", groupId)

// ─── H 轮换 ────────────────────────────────────────────────────────────────

/**
 * 踢人/主动轮换后推导新 fileMasterKey：`K_new = SHA256(K_old || eventId || nonce)`。
 * @return 新密钥（十六进制）
 */
fun deriveNextFileMasterKey(oldKeyHex: String, eventId: String, nonce: String): String {
	val digest = java.security.MessageDigest.getInstance("SHA-256")
	digest.update(hexToBytes(oldKeyHex))
	digest.update(eventId.toByteArray(Charsets.UTF_8))
	digest.update(nonce.toByteArray(Charsets.UTF_8))
	return bytesToHex(digest.digest())
}

/** @return 随机 32 字节 fileMasterKey hex */
fun generateFileMasterKey(): String = bytesToHex(randomBytes(32))

/** @return 随机 `new_key_nonce`（32 字节 hex） */
fun generateKeyRotationNonce(): String = bytesToHex(randomBytes(32))

// ─── Ed25519 → X25519 互转（内部用）────────────────────────────────────────

private val P25519: BigInteger = BigInteger.TWO.pow(255).subtract(BigInteger.valueOf(19))

/** 费马小定理求模逆元。 */
private fun modInv(a: BigInteger, m: BigInteger): BigInteger = a.mod(m).modPow(m.subtract(BigInteger.TWO), m)

/** Ed25519 公钥（Edwards y）→ X25519 公钥（Montgomery u）。 */
internal fun edPubToX25519(edPub: ByteArray): ByteArray {
	val yCopy = edPub.copyOf(32)
	yCopy[31] = (yCopy[31].toInt() and 0x7f).toByte()
	var y = BigInteger(1, yCopy.reversedArray())
	val u = BigInteger.ONE.add(y)
		.multiply(modInv(BigInteger.ONE.subtract(y).add(P25519), P25519))
		.mod(P25519)
	val result = ByteArray(32)
	var remaining = u
	val mask = BigInteger.valueOf(0xff)
	for (index in 0 until 32) {
		result[index] = remaining.and(mask).toByte()
		remaining = remaining.shiftRight(8)
	}
	return result
}

/** Ed25519 私钥种子（32 字节）→ X25519 私钥（RFC 7748 §4.1）。 */
internal fun edPrivToX25519(seed: ByteArray): ByteArray {
	val hash = sha512(seed)
	val key = hash.copyOf(32)
	key[0] = (key[0].toInt() and 248).toByte()
	key[31] = ((key[31].toInt() and 127) or 64).toByte()
	return key
}

private fun x25519Shared(priv: ByteArray, pub: ByteArray): ByteArray {
	val out = ByteArray(32)
	X25519.scalarMult(priv, 0, pub, 0, out, 0)
	return out
}

// ─── ECIES 密钥包装 ────────────────────────────────────────────────────────

/**
 * X25519 ECIES 包装任意 32 字节 hex 密钥给成员 Ed25519 公钥。
 * @return ECIES 包装（ephemPub/iv/ciphertext/authTag，均 base64）
 */
fun wrapKeyEcies(keyHex: String, recipientEdPubKeyHex: String): Map<String, Any?> {
	val memberX25519Pub = edPubToX25519(hexToBytes(recipientEdPubKeyHex))
	return eciesWrap(hexToBytes(keyHex), memberX25519Pub)
}

/**
 * 用本节点 Ed25519 私钥种子解密 ECIES 包装的 32 字节 hex 密钥。
 * @return 解密后的密钥 hex；失败 null
 */
fun unwrapKeyEcies(encryptedH: Any?, myEdPrivKeySeed: ByteArray): String? {
	val plain = eciesUnwrap(encryptedH, myEdPrivKeySeed) ?: return null
	return bytesToHex(plain)
}

/** ECIES 封装任意 UTF-8 载荷。 */
fun encryptUtf8ForMember(utf8Text: String, memberEdPubKeyHex: String): Map<String, Any?> {
	val memberX25519Pub = edPubToX25519(hexToBytes(memberEdPubKeyHex))
	return eciesWrap(utf8Text.toByteArray(Charsets.UTF_8), memberX25519Pub)
}

/** 解密 ECIES 包装的 UTF-8 载荷；失败 null。 */
fun decryptUtf8ForMember(encrypted: Any?, myEdPrivKeySeed: ByteArray): String? {
	val plain = eciesUnwrap(encrypted, myEdPrivKeySeed) ?: return null
	return String(plain, Charsets.UTF_8)
}

private fun eciesWrap(plain: ByteArray, memberX25519Pub: ByteArray): Map<String, Any?> {
	val ephemPriv = ByteArray(32)
	X25519.generatePrivateKey(java.security.SecureRandom(), ephemPriv)
	val ephemPub = ByteArray(32)
	X25519.scalarMultBase(ephemPriv, 0, ephemPub, 0)
	val wrapKey = sha256(x25519Shared(ephemPriv, memberX25519Pub))
	val iv = randomBytes(12)
	val sealed = aesGcmEncrypt(wrapKey, iv, plain)
	val ciphertext = sealed.copyOfRange(0, sealed.size - 16)
	val authTag = sealed.copyOfRange(sealed.size - 16, sealed.size)
	return mapOf(
		"ephemPub" to bytesToBase64(ephemPub),
		"iv" to bytesToBase64(iv),
		"ciphertext" to bytesToBase64(ciphertext),
		"authTag" to bytesToBase64(authTag),
	)
}

private fun eciesUnwrap(encrypted: Any?, myEdPrivKeySeed: ByteArray): ByteArray? {
	val map = encrypted as? Map<*, *> ?: return null
	try {
		val myX25519Priv = edPrivToX25519(myEdPrivKeySeed)
		val ephemPub = base64ToBytes(map["ephemPub"] as String)
		val sharedSecret = x25519Shared(myX25519Priv, ephemPub)
		val wrapKey = sha256(sharedSecret)
		val iv = base64ToBytes(map["iv"] as String)
		val ciphertext = base64ToBytes(map["ciphertext"] as String)
		val authTag = base64ToBytes(map["authTag"] as String)
		return aesGcmDecrypt(wrapKey, iv, ciphertext + authTag)
	}
	catch (_: Exception) {
		return null
	}
}

// ─── 收敛内容加密 ──────────────────────────────────────────────────────────

/** `contentKey = KDF(SHA256(plaintext), "ce")` 的 KDF 输入为 contentHash 字节。 */
fun deriveContentKey(contentHashHex: String): ByteArray {
	val mac = Mac.getInstance("HmacSHA256")
	mac.init(SecretKeySpec(hexToBytes(contentHashHex), "HmacSHA256"))
	mac.update("ce".toByteArray(Charsets.UTF_8))
	mac.update(0)
	return mac.doFinal()
}

/** 收敛加密结果（[contentKey] 仅随机模式填充）。 */
data class ConvergentCipher(
	val contentHash: String,
	val ciphertextHash: String,
	val raw: ByteArray,
	val contentKey: ByteArray? = null,
) {
	override fun equals(other: Any?): Boolean =
		other is ConvergentCipher && contentHash == other.contentHash &&
			ciphertextHash == other.ciphertextHash && raw.contentEquals(other.raw)

	override fun hashCode(): Int = (contentHash.hashCode() * 31 + ciphertextHash.hashCode()) * 31 + raw.contentHashCode()
}

/**
 * 收敛加密：同明文 → 同密文（IV 由 contentHash 前 12 字节派生）。
 */
fun encryptConvergentPlaintext(plaintext: ByteArray): ConvergentCipher {
	val contentHash = bytesToHex(sha256(plaintext))
	val contentKey = deriveContentKey(contentHash)
	val iv = hexToBytes(contentHash).copyOf(12)
	return buildConvergent(plaintext, contentKey, iv, contentHash)
}

/**
 * 高隐私模式：随机 contentKey + 随机 IV（放弃跨文件 dedup）。
 */
fun encryptRandomPlaintext(plaintext: ByteArray): ConvergentCipher {
	val contentKey = randomBytes(32)
	return encryptRandomPlaintextWithKey(plaintext, contentKey).copy(contentKey = contentKey)
}

/**
 * 用已有 contentKey 加密一块明文（多块 random 文件共用一把 key）。
 */
fun encryptRandomPlaintextWithKey(plaintext: ByteArray, contentKey: ByteArray): ConvergentCipher {
	val contentHash = bytesToHex(sha256(plaintext))
	val iv = randomBytes(12)
	return buildConvergent(plaintext, contentKey, iv, contentHash)
}

private fun buildConvergent(plaintext: ByteArray, contentKey: ByteArray, iv: ByteArray, contentHash: String): ConvergentCipher {
	val sealed = aesGcmEncrypt(contentKey, iv, plaintext)
	val ciphertext = sealed.copyOfRange(0, sealed.size - 16)
	val authTag = sealed.copyOfRange(sealed.size - 16, sealed.size)
	val raw = iv + authTag + ciphertext
	return ConvergentCipher(contentHash, bytesToHex(sha256(raw)), raw)
}

/**
 * 解密收敛密文块（`raw` = iv(12) || authTag(16) || ciphertext）。
 * @return 明文；校验失败为 null
 */
fun decryptConvergentCiphertext(raw: ByteArray, contentHashHex: String): ByteArray? {
	if (raw.size < 28) return null
	val iv = raw.copyOfRange(0, 12)
	val authTag = raw.copyOfRange(12, 28)
	val ciphertext = raw.copyOfRange(28, raw.size)
	val contentKey = deriveContentKey(contentHashHex)
	val plain = aesGcmDecrypt(contentKey, iv, ciphertext + authTag) ?: return null
	if (bytesToHex(sha256(plain)) != contentHashHex) return null
	return plain
}

/**
 * 用随机 contentKey 解密密文块（`raw` = iv(12) || authTag(16) || ciphertext）。
 * @return 明文；校验失败返回 null
 */
fun decryptRandomCiphertext(raw: ByteArray, contentKey: ByteArray, contentHashHex: String = ""): ByteArray? {
	if (raw.size < 28) return null
	val iv = raw.copyOfRange(0, 12)
	val authTag = raw.copyOfRange(12, 28)
	val ciphertext = raw.copyOfRange(28, raw.size)
	val plain = aesGcmDecrypt(contentKey, iv, ciphertext + authTag) ?: return null
	if (contentHashHex.isNotEmpty() && bytesToHex(sha256(plain)) != contentHashHex) return null
	return plain
}

/**
 * 用 `KDF(H,"file",fileId)` 包裹 contentKey。
 */
fun wrapContentKey(contentKey: ByteArray, h: Any?, fileId: String): Map<String, Any?> {
	val wrapKey = deriveFileKey(h, fileId)
	val iv = randomBytes(12)
	val sealed = aesGcmEncrypt(wrapKey, iv, contentKey)
	val ciphertext = sealed.copyOfRange(0, sealed.size - 16)
	val authTag = sealed.copyOfRange(sealed.size - 16, sealed.size)
	return mapOf(
		"iv" to bytesToBase64(iv),
		"ciphertext" to bytesToBase64(ciphertext),
		"authTag" to bytesToBase64(authTag),
	)
}

/**
 * 解开 wrappedKey 得到 contentKey；失败 null。
 */
fun unwrapContentKey(wrapped: Any?, h: Any?, fileId: String): ByteArray? {
	val map = wrapped as? Map<*, *> ?: return null
	try {
		val wrapKey = deriveFileKey(h, fileId)
		val iv = base64ToBytes(map["iv"] as String)
		val ciphertext = base64ToBytes(map["ciphertext"] as String)
		val authTag = base64ToBytes(map["authTag"] as String)
		return aesGcmDecrypt(wrapKey, iv, ciphertext + authTag)
	}
	catch (_: Exception) {
		return null
	}
}
