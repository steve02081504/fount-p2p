package io.github.steve02081504.fountp2p.discovery.internal

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.base64ToBytes
import io.github.steve02081504.fountp2p.core.bytesToBase64
import io.github.steve02081504.fountp2p.crypto.aesGcmDecrypt
import io.github.steve02081504.fountp2p.crypto.aesGcmEncrypt
import io.github.steve02081504.fountp2p.crypto.randomBytes
import io.github.steve02081504.fountp2p.crypto.sha256
import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.utils.LruMap

private const val SIGNAL_DOMAIN = "fount-signal"
private const val NODE_RENDEZVOUS_DOMAIN = "fount-rdv-node:"
private const val GROUP_RENDEZVOUS_DOMAIN = "fount-rdv-group:"
private const val NETWORK_RENDEZVOUS_DOMAIN = "fount-rdv-network:"

/** rendezvous 键 → AES-256 密钥缓存上限 */
const val SIGNAL_KEY_CACHE_MAX = 512

/**
 * 节点 rendezvous 键（discovery advert / signal）。
 * @param nodeHash 节点 64 hex
 * @return rendezvous 键
 */
fun nodeRendezvousKey(nodeHash: String): String = bytesToHex(sha256("$NODE_RENDEZVOUS_DOMAIN$nodeHash"))

/**
 * 群组 rendezvous 键（roomSecret）。
 * @param roomSecret 房间密钥
 * @return rendezvous 键
 */
fun groupRendezvousKey(roomSecret: String): String = bytesToHex(sha256("$GROUP_RENDEZVOUS_DOMAIN$roomSecret"))

/**
 * 全网 network-scope rendezvous 键。
 * @return rendezvous 键
 */
fun networkRendezvousKey(): String = bytesToHex(sha256(NETWORK_RENDEZVOUS_DOMAIN))

/** rendezvous 键 → AES-256 密钥 LRU */
private val signalKeysByKey = LruMap<String, ByteArray>(SIGNAL_KEY_CACHE_MAX)

private fun signalKeyForRendezvous(rendezvousKey: String): ByteArray {
	val cached = signalKeysByKey.get(rendezvousKey)
	if (cached != null) {
		signalKeysByKey.touch(rendezvousKey, cached)
		return cached
	}
	val derived = sha256("$SIGNAL_DOMAIN:$rendezvousKey")
	signalKeysByKey.touch(rendezvousKey, derived)
	return derived
}

/** @return 密钥缓存条目数（测试用） */
fun signalKeyCacheSize(): Int = signalKeysByKey.size

/**
 * AES-GCM 封装 JSON 信令 / advert 包。
 * @param rendezvousKey rendezvous 键
 * @param packet 待加密 JSON
 * @return 加密字节
 */
fun encryptSignalPacket(rendezvousKey: String, packet: Any?): ByteArray {
	val iv = randomBytes(12)
	val sealed = aesGcmEncrypt(signalKeyForRendezvous(rendezvousKey), iv, (Json.stringify(packet) ?: "null").toByteArray(Charsets.UTF_8))
	val ciphertext = sealed.copyOfRange(0, sealed.size - 16)
	val authTag = sealed.copyOfRange(sealed.size - 16, sealed.size)
	val payload = linkedMapOf<String, Any?>(
		"iv" to bytesToBase64(iv),
		"authTag" to bytesToBase64(authTag),
		"ciphertext" to bytesToBase64(ciphertext),
	)
	return (Json.stringify(payload) ?: "null").toByteArray(Charsets.UTF_8)
}

/**
 * Untrusted ingress：AES-GCM 解密信令 / advert；失败返回 null。
 * @param rendezvousKey rendezvous 键
 * @param bytes 加密字节
 * @return 解密 JSON 或 null
 */
fun decryptSignalPacket(rendezvousKey: String, bytes: ByteArray): Map<String, Any?>? {
	return try {
		val payload = Json.parse(String(bytes, Charsets.UTF_8)) as? Map<*, *> ?: return null
		val iv = base64ToBytes(payload["iv"] as? String ?: return null)
		val authTag = base64ToBytes(payload["authTag"] as? String ?: return null)
		val ciphertext = base64ToBytes(payload["ciphertext"] as? String ?: return null)
		val plain = aesGcmDecrypt(signalKeyForRendezvous(rendezvousKey), iv, ciphertext + authTag) ?: return null
		Json.parse(String(plain, Charsets.UTF_8)) as? Map<String, Any?>
	}
	catch (_: Exception) {
		null
	}
}
