package io.github.steve02081504.fountp2p.crypto

import io.github.steve02081504.fountp2p.core.bytesToHex
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * 跨端 Ed25519 / SHA-256（JVM 与 Android 共用；基于 BouncyCastle 与 JCA）。
 */

private val secureRandom = SecureRandom()

/** @return 密码学安全随机字节 */
fun randomBytes(length: Int): ByteArray {
	val out = ByteArray(length)
	secureRandom.nextBytes(out)
	return out
}

/** @param data 字节 @return SHA-256 摘要 */
fun sha256(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(data)

/** @param text UTF-8 文本 @return SHA-256 摘要 */
fun sha256(text: String): ByteArray = sha256(text.toByteArray(Charsets.UTF_8))

/** @param data 字节 @return SHA-512 摘要 */
fun sha512(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-512").digest(data)

/** @param data 字节或 UTF-8 文本 @return 64 字符 hex */
fun sha256Hex(data: Any?): String = bytesToHex(sha256(inputBytes(data)))

/** Ed25519 密钥对。 */
data class KeyPairBytes(val publicKey: ByteArray, val secretKey: ByteArray) {
	override fun equals(other: Any?): Boolean =
		other is KeyPairBytes && publicKey.contentEquals(other.publicKey) && secretKey.contentEquals(other.secretKey)

	override fun hashCode(): Int = 31 * publicKey.contentHashCode() + secretKey.contentHashCode()
}

/**
 * @param data 字节或 UTF-8 文本
 * @return 规范化字节
 */
fun inputBytes(data: Any?): ByteArray =
	if (data is String) data.toByteArray(Charsets.UTF_8) else io.github.steve02081504.fountp2p.core.toBytes(data)

/**
 * @param seed 任意长度；非 32 字节时 sha256 派生
 * @return 32 字节私钥与对应公钥
 */
fun keyPairFromSeed(seed: ByteArray): KeyPairBytes {
	val sk = if (seed.size == 32) seed else sha256(seed)
	val secret = sk.copyOf(32)
	val privateKey = Ed25519PrivateKeyParameters(secret, 0)
	return KeyPairBytes(privateKey.generatePublicKey().encoded, secret)
}

/** @return 随机密钥对 */
fun randomKeyPair(): KeyPairBytes = keyPairFromSeed(randomBytes(32))

/**
 * @param secretKey 私钥种子
 * @return 公钥
 */
fun publicKeyFromSeed(secretKey: ByteArray): ByteArray {
	val seed = secretKey.copyOf(minOf(32, secretKey.size)).let { if (it.size == 32) it else sha256(secretKey) }
	return Ed25519PrivateKeyParameters(seed, 0).generatePublicKey().encoded
}

/**
 * @param message 待签名消息（字节或 UTF-8 文本）
 * @param secretKey 私钥（取前 32 字节为种子）
 * @return 64 字节签名
 */
fun sign(message: Any?, secretKey: ByteArray): ByteArray {
	val seed = secretKey.copyOf(32)
	val signer = Ed25519Signer()
	signer.init(true, Ed25519PrivateKeyParameters(seed, 0))
	val bytes = inputBytes(message)
	signer.update(bytes, 0, bytes.size)
	return signer.generateSignature()
}

/**
 * @param signature 64 字节签名
 * @param message 原始消息
 * @param publicKey 公钥
 * @return 合法为 true；异常或失败为 false
 */
fun verify(signature: ByteArray, message: Any?, publicKey: ByteArray): Boolean {
	if (signature.size != 64 || publicKey.size != 32) return false
	try {
		val signer = Ed25519Signer()
		signer.init(false, Ed25519PublicKeyParameters(publicKey, 0))
		val bytes = inputBytes(message)
		signer.update(bytes, 0, bytes.size)
		return signer.verifySignature(signature)
	}
	catch (_: Exception) {
		return false
	}
}

/**
 * @param publicKey 公钥字节
 * @return 64 字符 hex
 */
fun pubKeyHash(publicKey: ByteArray): String = bytesToHex(sha256(publicKey))
