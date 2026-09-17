package io.github.steve02081504.fountp2p.crypto

import org.bouncycastle.crypto.ec.CustomNamedCurves
import org.bouncycastle.math.ec.ECPoint
import java.io.ByteArrayOutputStream
import java.math.BigInteger

/**
 * BIP340 Schnorr（secp256k1）。
 *
 * Nostr 事件签名用；与 `@noble/curves` 的 `schnorr` 等价（见 SchnorrTest 中由 noble 生成的向量）。
 */

private val SECP256K1 = CustomNamedCurves.getByName("secp256k1")

/** secp256k1 曲线参数。 */
private val CURVE = SECP256K1.curve

/** 生成元。 */
private val G = SECP256K1.g

/** 群阶 n。 */
private val N = SECP256K1.n

/** 域特征 p。 */
private val FIELD_P = CURVE.field.characteristic

/** @return 32 字节大端编码（必要时左补零/截断高位）。 */
private fun padded32(value: BigInteger): ByteArray {
	val raw = value.toByteArray()
	if (raw.size == 32) return raw
	val out = ByteArray(32)
	if (raw.size > 32) raw.copyInto(out, 0, raw.size - 32) else raw.copyInto(out, 32 - raw.size)
	return out
}

/**
 * BIP340 tagged hash：`sha256(sha256(tag) || sha256(tag) || msg...)`。
 * @param tag 标签
 * @param parts 消息片段
 * @return 32 字节摘要
 */
private fun taggedHash(tag: String, vararg parts: ByteArray): ByteArray {
	val tagHash = sha256(tag.toByteArray(Charsets.UTF_8))
	val buffer = ByteArrayOutputStream()
	buffer.write(tagHash)
	buffer.write(tagHash)
	for (part in parts) buffer.write(part)
	return sha256(buffer.toByteArray())
}

/** @return 点归一化后 y 是否为偶。 */
private fun hasEvenY(point: ECPoint): Boolean = !point.normalize().affineYCoord.toBigInteger().testBit(0)

/**
 * 由 x 恢复偶 y 点。
 * @param x 横坐标
 * @return 点，x 非法时 null
 */
private fun liftX(x: BigInteger): ECPoint? {
	if (x >= FIELD_P) return null
	return try {
		CURVE.decodePoint(byteArrayOf(0x02) + padded32(x))
	}
	catch (_: Exception) {
		null
	}
}

private fun secretKeyScalar(secretKey: ByteArray): BigInteger {
	val d0 = BigInteger(1, secretKey)
	require(d0 >= BigInteger.ONE && d0 < N) { "p2p: invalid schnorr secret key" }
	return d0
}

/**
 * x-only 公钥（BIP340）。
 * @param secretKey 32 字节私钥
 * @return 32 字节偶 y 的公钥横坐标
 */
fun schnorrPublicKey(secretKey: ByteArray): ByteArray =
	padded32(G.multiply(secretKeyScalar(secretKey)).normalize().affineXCoord.toBigInteger())

/**
 * BIP340 签名。
 * @param message 待签消息（Nostr 中为 32 字节事件 id）
 * @param secretKey 32 字节私钥
 * @param auxRand 32 字节辅助随机数
 * @return 64 字节 `r || s`
 */
@JvmOverloads
fun schnorrSign(message: ByteArray, secretKey: ByteArray, auxRand: ByteArray = randomBytes(32)): ByteArray {
	val d0 = secretKeyScalar(secretKey)
	val point = G.multiply(d0).normalize()
	val d = if (hasEvenY(point)) d0 else N.subtract(d0)
	val px = padded32(point.affineXCoord.toBigInteger())
	val aux = if (auxRand.size == 32) auxRand else padded32(BigInteger(1, auxRand))
	val t = padded32(d.xor(BigInteger(1, taggedHash("BIP0340/aux", aux))))
	val k0 = BigInteger(1, taggedHash("BIP0340/nonce", t, px, message)).mod(N)
	check(k0 != BigInteger.ZERO) { "p2p: schnorr nonce is zero" }
	val noncePoint = G.multiply(k0).normalize()
	val k = if (hasEvenY(noncePoint)) k0 else N.subtract(k0)
	val rx = padded32(noncePoint.affineXCoord.toBigInteger())
	val e = BigInteger(1, taggedHash("BIP0340/challenge", rx, px, message)).mod(N)
	val s = k.add(e.multiply(d)).mod(N)
	val signature = rx + padded32(s)
	check(schnorrVerify(message, signature, px)) { "p2p: schnorr self-verify failed" }
	return signature
}

/**
 * BIP340 验签。
 * @param message 待验消息
 * @param signature 64 字节签名
 * @param publicKey 32 字节 x-only 公钥
 * @return 是否有效
 */
fun schnorrVerify(message: ByteArray, signature: ByteArray, publicKey: ByteArray): Boolean {
	if (signature.size != 64 || publicKey.size != 32) return false
	val rx = BigInteger(1, signature.copyOfRange(0, 32))
	val s = BigInteger(1, signature.copyOfRange(32, 64))
	if (rx >= FIELD_P || s >= N) return false
	val point = liftX(BigInteger(1, publicKey)) ?: return false
	val e = BigInteger(1, taggedHash("BIP0340/challenge", signature.copyOfRange(0, 32), publicKey, message)).mod(N)
	val result = G.multiply(s).subtract(point.multiply(e)).normalize()
	if (result.isInfinity) return false
	if (!hasEvenY(result)) return false
	return result.affineXCoord.toBigInteger() == rx
}
