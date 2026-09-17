package io.github.steve02081504.fountp2p.discovery

import io.github.steve02081504.fountp2p.discovery.internal.decryptSignalPacket
import io.github.steve02081504.fountp2p.discovery.internal.encryptSignalPacket
import io.github.steve02081504.fountp2p.discovery.internal.groupRendezvousKey
import io.github.steve02081504.fountp2p.discovery.internal.networkRendezvousKey
import io.github.steve02081504.fountp2p.discovery.internal.nodeRendezvousKey
import io.github.steve02081504.fountp2p.link.buildSignedAdvert
import io.github.steve02081504.fountp2p.link.verifySignedAdvert

/** advert 域：`'node'`、`'network'` 或 `{ roomSecret }`。 */
typealias AdvertScope = Any?

/**
 * 按 scope 派生 rendezvous 键。
 * @param scope advert 域
 * @param selfNodeHash 本机 nodeHash
 * @return rendezvous 键（discovery 内部）
 */
fun rendezvousKeyForScope(scope: AdvertScope, selfNodeHash: String): String {
	if (scope == "network") return networkRendezvousKey()
	if (scope == "node") return nodeRendezvousKey(selfNodeHash)
	val secret = (scope as? Map<*, *>)?.get("roomSecret")?.toString()
	if (!secret.isNullOrEmpty()) return groupRendezvousKey(secret)
	throw IllegalArgumentException("p2p: invalid advert scope")
}

/**
 * 为本机身份构建已签名 advert body。
 * @param scope advert 域
 * @param localIdentity 本地身份
 * @param tcpPort LAN TCP 端口
 * @param relayData 已规范化并经 sanitize 裁剪的 relay 字段 `{ pool, listen }`
 * @return 签名 advert body
 */
@JvmOverloads
fun buildSignedAdvertForScope(
	scope: AdvertScope,
	localIdentity: Map<String, Any?>,
	tcpPort: Any? = null,
	relayData: Map<String, Any?>? = null,
): Map<String, Any?> {
	val key = rendezvousKeyForScope(scope, localIdentity["nodeHash"] as? String ?: "")
	val lanHosts = if (scope == "network" && tcpPort != null) listMulticastIpv4Addresses() else emptyList()
	val options = LinkedHashMap<String, Any?>(localIdentity)
	if (tcpPort != null) options["tcpPort"] = tcpPort
	if (lanHosts.isNotEmpty()) options["lanHosts"] = lanHosts
	val pool = relayData?.get("pool")
	if (pool != null) options["nostrRelayPool"] = pool
	val listen = relayData?.get("listen")
	if (listen != null) options["listenNostrRelays"] = listen
	return buildSignedAdvert(key, System.currentTimeMillis().toDouble(), options)
}

/**
 * AES-GCM 封装已签名 advert 包。
 * @param rendezvousKey rendezvous 键
 * @param advertBody 已签名 advert
 * @return 加密 advert 字节
 */
fun encryptAdvertPacket(rendezvousKey: String, advertBody: Map<String, Any?>): ByteArray =
	encryptSignalPacket(rendezvousKey, linkedMapOf("type" to "advert", "body" to advertBody))

/**
 * 按 scope 加密已签名 advert。
 * @param scope advert 域
 * @param localIdentity 本地身份（仅需 nodeHash）
 * @param advertBody 已签名 advert
 * @return 加密 advert 字节
 */
fun encryptAdvertForScope(scope: AdvertScope, localIdentity: Map<String, Any?>, advertBody: Map<String, Any?>): ByteArray =
	encryptAdvertPacket(rendezvousKeyForScope(scope, localIdentity["nodeHash"] as? String ?: ""), advertBody)

/**
 * Untrusted ingress：解密并验签 advert；失败返回 null，不抛。
 * @param rendezvousKey rendezvous 键
 * @param bytes 加密 advert
 * @return 验签成功返回 nodeHash、advert body 与规范化 relay 字段，否则 null
 */
fun ingestEncryptedAdvert(rendezvousKey: String, bytes: ByteArray): Map<String, Any?>? {
	val packet = decryptSignalPacket(rendezvousKey, bytes) ?: return null
	if (packet["type"] != "advert") return null
	val body = packet["body"] as? Map<String, Any?> ?: return null
	val verified = verifySignedAdvert(rendezvousKey, body) ?: return null
	return linkedMapOf(
		"verifiedNodeHash" to verified.nodeHash,
		"body" to body,
		"relayPool" to verified.relayPool,
		"listenRelays" to verified.listenRelays,
	)
}

/**
 * Untrusted ingress：验签 network-scope advert；失败返回 null。
 * @param bytes 加密 advert
 * @return 验签结果或 null
 */
fun ingestNetworkAdvert(bytes: ByteArray): Map<String, Any?>? = ingestEncryptedAdvert(networkRendezvousKey(), bytes)

/**
 * Untrusted ingress：验签 node-scope advert；失败返回 null。
 * @param nodeHash 目标 nodeHash
 * @param bytes 加密 advert
 * @return 验签结果或 null
 */
fun ingestNodeAdvert(nodeHash: String, bytes: ByteArray): Map<String, Any?>? =
	ingestEncryptedAdvert(nodeRendezvousKey(nodeHash), bytes)

/**
 * Untrusted ingress：验签 group-scope advert；失败返回 null。
 * @param roomSecret 房间密钥
 * @param bytes 加密 advert
 * @return 验签结果或 null
 */
fun ingestGroupAdvert(roomSecret: String, bytes: ByteArray): Map<String, Any?>? =
	ingestEncryptedAdvert(groupRendezvousKey(roomSecret), bytes)
