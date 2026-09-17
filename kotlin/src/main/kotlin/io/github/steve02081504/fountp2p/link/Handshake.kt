package io.github.steve02081504.fountp2p.link

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.core.hexToBytes
import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.core.isSignatureHex128
import io.github.steve02081504.fountp2p.core.normalizeTcpPort
import io.github.steve02081504.fountp2p.crypto.keyPairFromSeed
import io.github.steve02081504.fountp2p.crypto.pubKeyHash
import io.github.steve02081504.fountp2p.crypto.randomBytes
import io.github.steve02081504.fountp2p.crypto.sign
import io.github.steve02081504.fountp2p.crypto.verify
import io.github.steve02081504.fountp2p.discovery.normalizeLanHosts
import io.github.steve02081504.fountp2p.discovery.nostr.MAX_ADVERT_LISTEN_RELAYS
import io.github.steve02081504.fountp2p.discovery.nostr.MAX_ADVERT_RELAY_POOL
import io.github.steve02081504.fountp2p.discovery.nostr.MAX_RTT_MS
import io.github.steve02081504.fountp2p.discovery.nostr.normalizeNostrRelayUrl
import io.github.steve02081504.fountp2p.node.ensureNodeSeed
import io.github.steve02081504.fountp2p.node.getNodeHash
import io.github.steve02081504.fountp2p.node.nodeDebug

/** Link 握手签名域标识符。 */
const val LINK_HANDSHAKE_DOMAIN = "fount-link"

private fun jsNumber(value: Any?): String =
	Json.jsNumberToString((value as? Number)?.toDouble() ?: Double.NaN)

/**
 * 规范化链路绑定材料：DTLS fingerprint 或 64-hex linkId。
 * @param value 原始 binding
 * @return 规范化 binding，无效时 null
 */
fun normalizeLinkBinding(value: Any?): String? = normalizeDtlsFingerprint(value) ?: isHex64(value)

/**
 * 构造 link auth 待签名字节串。
 * @param peerNonce 对端 hello 中的 nonce（64 位 hex）
 * @param localBinding 本地绑定材料（DTLS fingerprint 或 linkId）
 * @param localNodeHash 本地节点 nodeHash（64 位 hex）
 * @return 待签名消息字节
 */
fun buildAuthMessage(peerNonce: String?, localBinding: Any?, localNodeHash: String?): ByteArray {
	val binding = normalizeLinkBinding(localBinding)
	if (peerNonce == null || !Regex("^[\\da-f]{64}$").matches(peerNonce))
		throw IllegalArgumentException("p2p: auth nonce must be 64 hex characters")
	if (binding == null) throw IllegalArgumentException("p2p: link binding missing or invalid")
	if (isHex64(localNodeHash) == null) throw IllegalArgumentException("p2p: nodeHash must be 64 hex characters")
	return "$LINK_HANDSHAKE_DOMAIN\u0000$peerNonce\u0000$binding\u0000$localNodeHash".toByteArray(Charsets.UTF_8)
}

/**
 * 构造 link hello 握手包。
 * @param options 可选身份字段，省略则从本地节点种子推导
 * @return hello 对象
 */
@JvmOverloads
fun buildHello(options: Map<String, Any?> = emptyMap()): Map<String, Any?> {
	var publicKey: ByteArray? = null
	val optHash = options["nodeHash"] as? String
	val optPub = options["nodePubKey"] as? String
	if (optHash.isNullOrEmpty() || optPub.isNullOrEmpty()) {
		val derived = keyPairFromSeed(hexToBytes(ensureNodeSeed()))
		publicKey = derived.publicKey
	}
	val nodeHash = isHex64(if (!optHash.isNullOrEmpty()) optHash else getNodeHash())
	val nodePubKey = isHex64(if (!optPub.isNullOrEmpty()) optPub else bytesToHex(publicKey ?: ByteArray(0)))
	val nonce = isHex64((options["nonce"] as? String) ?: bytesToHex(randomBytes(32)))
	if (nodeHash == null || nodePubKey == null || nonce == null)
		throw IllegalArgumentException("p2p: invalid hello fields")
	if (pubKeyHash(hexToBytes(nodePubKey)) != nodeHash)
		throw IllegalArgumentException("p2p: hello nodePubKey does not match nodeHash")
	return linkedMapOf("nodeHash" to nodeHash, "nodePubKey" to nodePubKey, "nonce" to nonce)
}

/**
 * 对 link auth 消息签名。
 * @param peerNonce 对端 hello 中的 nonce
 * @param localBinding 本地绑定材料（DTLS fingerprint 或 linkId）
 * @param options 签名密钥与 nodeHash 覆盖
 * @return `{ sig: hex 签名 }`
 */
@JvmOverloads
fun buildAuth(peerNonce: String?, localBinding: Any?, options: Map<String, Any?> = emptyMap()): Map<String, Any?> {
	val seed = (options["secretKey"] as? ByteArray) ?: hexToBytes(ensureNodeSeed())
	val keyPair = keyPairFromSeed(seed)
	val nodeHash = (options["nodeHash"] as? String) ?: pubKeyHash(keyPair.publicKey)
	if (nodeHash != pubKeyHash(keyPair.publicKey))
		throw IllegalArgumentException("p2p: auth nodeHash does not match secretKey")
	val message = buildAuthMessage(peerNonce, localBinding, nodeHash)
	return linkedMapOf("sig" to bytesToHex(sign(message, keyPair.secretKey)))
}

/**
 * 解析并校验 hello 对象，无效时返回 null。
 * @param hello 原始 hello 载荷
 * @return 规范化 hello 或 null
 */
fun parseHello(hello: Any?): Map<String, Any?>? {
	val obj = hello as? Map<*, *> ?: return null
	val nodeHash = isHex64(obj["nodeHash"]) ?: return null
	val nodePubKey = isHex64(obj["nodePubKey"]) ?: return null
	val nonce = isHex64(obj["nonce"]) ?: return null
	return try {
		if (pubKeyHash(hexToBytes(nodePubKey)) != nodeHash) null
		else linkedMapOf("nodeHash" to nodeHash, "nodePubKey" to nodePubKey, "nonce" to nonce)
	}
	catch (_: Exception) {
		null
	}
}

/**
 * 验证对端 auth 签名，成功返回对端 nodeHash。
 * @param hello 对端 hello
 * @param auth 对端 auth（含 sig）
 * @param expectedNonce 本地 hello 发出的 nonce
 * @param remoteBinding 对端绑定材料
 * @return 验证通过的 nodeHash，失败返回 null
 */
fun verifyAuth(hello: Any?, auth: Any?, expectedNonce: String?, remoteBinding: Any?): String? {
	val parsedHello = parseHello(hello) ?: return null
	val authObj = auth as? Map<*, *> ?: return null
	val signatureHex = isSignatureHex128(authObj["sig"]) ?: return null
	val binding = normalizeLinkBinding(remoteBinding) ?: return null
	val normalizedNonce = isHex64(expectedNonce) ?: return null
	val message = buildAuthMessage(normalizedNonce, binding, parsedHello["nodeHash"] as String)
	val ok = verify(hexToBytes(signatureHex), message, hexToBytes(parsedHello["nodePubKey"] as String))
	return if (ok) parsedHello["nodeHash"] as String else null
}

/**
 * 构造 discovery advert 待签名字节串。
 * @param rendezvousKey discovery 内部汇合键
 * @param ts 时间戳（毫秒）
 * @param nodeHash 节点 nodeHash
 * @param tcpPort 可选 LAN TCP 监听端口
 * @param lanHosts 可选 LAN IPv4 列表
 * @param relayBlobHex 可选规范化 relay 字段 hex 段
 * @return 待签名消息字节
 */
@JvmOverloads
fun buildAdvertMessage(
	rendezvousKey: String,
	ts: Any?,
	nodeHash: String,
	tcpPort: Any? = null,
	lanHosts: Any? = null,
	relayBlobHex: String? = null,
): ByteArray {
	var message = "fount-advert\u0000$rendezvousKey\u0000${jsNumber(ts)}\u0000$nodeHash"
	val port = normalizeTcpPort(tcpPort)
	if (port != null) message += "\u0000$port"
	val hosts = normalizeLanHosts(lanHosts)
	if (hosts.isNotEmpty()) message += "\u0000" + hosts.joinToString(",")
	if (!relayBlobHex.isNullOrEmpty()) message += "\u0000relays:$relayBlobHex"
	return message.toByteArray(Charsets.UTF_8)
}

/** 规范化 relay 字段结果。 */
data class SanitizedRelayFields(val pool: List<Map<String, Any?>>, val listen: List<String>)

/**
 * 规范化并裁剪入站（不可信）advert 携带的 relay 字段：无效项丢弃并记审计日志，不抛错。
 * @param rawPool 原始 pool（[{url, rttMs}]）
 * @param rawListen 原始 listen（[url]）
 * @return 规范化结果
 */
fun sanitizeAdvertRelayFields(rawPool: Any?, rawListen: Any?): SanitizedRelayFields {
	val pool = ArrayList<Map<String, Any?>>()
	val seenPool = HashSet<String>()
	if (rawPool is List<*>) for (rawItem in rawPool) {
		val item = rawItem as? Map<*, *>
		val url = normalizeNostrRelayUrl(item?.get("url"))
		if (url == null) {
			nodeDebug(
				"invalidRelayUrl",
				linkedMapOf("url" to (item?.get("url")?.toString() ?: ""), "reason" to "advert-pool-invalid-url"),
			)
			continue
		}
		val rawRtt = item?.get("rttMs") ?: item?.get("rtt")
		val rtt = (rawRtt as? Number)?.toDouble()
		if (rtt == null || rtt.isNaN() || rtt.isInfinite() || rtt < 0 || rtt > MAX_RTT_MS) {
			nodeDebug(
				"invalidRelayUrl",
				linkedMapOf("url" to url, "reason" to "advert-pool-invalid-rtt", "rttMs" to rawRtt),
			)
			continue
		}
		if (seenPool.contains(url)) continue
		seenPool.add(url)
		pool.add(linkedMapOf("url" to url, "rtt" to Math.round(rtt).toDouble()))
		if (pool.size >= MAX_ADVERT_RELAY_POOL) break
	}

	val listen = ArrayList<String>()
	val seenListen = HashSet<String>()
	if (rawListen is List<*>) for (raw in rawListen) {
		val url = normalizeNostrRelayUrl(raw)
		if (url == null) {
			nodeDebug(
				"invalidRelayUrl",
				linkedMapOf("url" to (raw?.toString() ?: ""), "reason" to "advert-listen-invalid-url"),
			)
			continue
		}
		if (seenListen.contains(url)) continue
		seenListen.add(url)
		listen.add(url)
		if (listen.size >= MAX_ADVERT_LISTEN_RELAYS) break
	}
	return SanitizedRelayFields(pool, listen)
}

/**
 * 构建规范化 relay 字段的 canonical blob（pool/listen 各按 url 排序 → `{p,l}` JSON → UTF-8 → hex）。
 * @param pool 规范化 pool
 * @param listen 规范化 listen
 * @return hex 编码 blob
 */
fun canonicalAdvertRelayBlob(pool: List<Map<String, Any?>>, listen: List<String>): String {
	val sortedPool = pool.sortedWith(compareBy { it["url"] as String })
	val sortedListen = listen.sorted()
	return bytesToHex((Json.stringify(linkedMapOf<String, Any?>("p" to sortedPool, "l" to sortedListen)) ?: "null").toByteArray(Charsets.UTF_8))
}

/**
 * 严格规范化本机（出站）提供的 relay 字段：无效数据立即抛错。
 * @param rawPool 原始 pool
 * @param rawListen 原始 listen
 * @return 规范化结果
 */
private fun normalizeLocalRelayFields(rawPool: Any?, rawListen: Any?): SanitizedRelayFields {
	val pool = ArrayList<Map<String, Any?>>()
	val seenPool = HashSet<String>()
	if (rawPool != null && rawPool !== io.github.steve02081504.fountp2p.core.JsonUndefined && rawPool !is List<*>)
		throw IllegalArgumentException("p2p: advert pool invalid type")
	if (rawPool is List<*>) for (rawItem in rawPool) {
		val item = rawItem as? Map<*, *>
		val url = normalizeNostrRelayUrl(item?.get("url"))
			?: throw IllegalArgumentException("p2p: advert pool invalid url")
		val rawRtt = item?.get("rttMs") ?: item?.get("rtt")
		val rtt = (rawRtt as? Number)?.toDouble()
		if (rtt == null || rtt.isNaN() || rtt.isInfinite() || rtt < 0 || rtt > MAX_RTT_MS)
			throw IllegalArgumentException("p2p: advert pool invalid rtt")
		if (seenPool.contains(url)) continue
		seenPool.add(url)
		pool.add(linkedMapOf("url" to url, "rtt" to Math.round(rtt).toDouble()))
		if (pool.size >= MAX_ADVERT_RELAY_POOL) break
	}

	val listen = ArrayList<String>()
	val seenListen = HashSet<String>()
	if (rawListen != null && rawListen !== io.github.steve02081504.fountp2p.core.JsonUndefined && rawListen !is List<*>)
		throw IllegalArgumentException("p2p: advert listen invalid type")
	if (rawListen is List<*>) for (raw in rawListen) {
		val url = normalizeNostrRelayUrl(raw) ?: throw IllegalArgumentException("p2p: advert listen invalid url")
		if (seenListen.contains(url)) continue
		seenListen.add(url)
		listen.add(url)
		if (listen.size >= MAX_ADVERT_LISTEN_RELAYS) break
	}
	return SanitizedRelayFields(pool, listen)
}

private fun isTruthy(value: Any?): Boolean = io.github.steve02081504.fountp2p.federation.jsTruthy(value)

/**
 * 构造带签名的 discovery advert（tcpPort / lanHosts / relay 字段一并签入消息）。
 * @param rendezvousKey discovery 内部汇合键
 * @param ts 时间戳（毫秒）
 * @param options 签名身份与可选字段
 * @return 签名 advert
 */
@JvmOverloads
fun buildSignedAdvert(rendezvousKey: String, ts: Any? = System.currentTimeMillis().toDouble(), options: Map<String, Any?>? = null): Map<String, Any?> {
	val opts = options ?: emptyMap()
	val seed = (opts["secretKey"] as? ByteArray) ?: hexToBytes(ensureNodeSeed())
	val keyPair = keyPairFromSeed(seed)
	val nodeHash = (opts["nodeHash"] as? String) ?: pubKeyHash(keyPair.publicKey)
	val nodePubKey = (opts["nodePubKey"] as? String) ?: bytesToHex(keyPair.publicKey)
	if (pubKeyHash(hexToBytes(nodePubKey)) != nodeHash)
		throw IllegalArgumentException("p2p: advert nodePubKey does not match nodeHash")
	val tcpPort = normalizeTcpPort(opts["tcpPort"])
	if (isTruthy(opts["tcpPort"]) && tcpPort == null)
		throw IllegalArgumentException("p2p: advert tcpPort invalid")
	val lanHosts = normalizeLanHosts(opts["lanHosts"])
	val normalized = normalizeLocalRelayFields(opts["nostrRelayPool"], opts["listenNostrRelays"])
	val message = buildAdvertMessage(rendezvousKey, ts, nodeHash, tcpPort, lanHosts, canonicalAdvertRelayBlob(normalized.pool, normalized.listen))
	val sig = sign(message, keyPair.secretKey)
	val advert = LinkedHashMap<String, Any?>()
	advert["nodeHash"] = nodeHash
	advert["nodePubKey"] = nodePubKey
	advert["ts"] = ts
	advert["sig"] = bytesToHex(sig)
	if (tcpPort != null) advert["tcpPort"] = tcpPort.toDouble()
	if (lanHosts.isNotEmpty()) advert["lanHosts"] = lanHosts
	if (normalized.pool.isNotEmpty()) advert["nostrRelayPool"] = normalized.pool
	if (normalized.listen.isNotEmpty()) advert["listenNostrRelays"] = normalized.listen
	return advert
}

/** advert 验签结果。 */
data class VerifiedAdvert(
	val nodeHash: String,
	val relayPool: List<Map<String, Any?>>,
	val listenRelays: List<String>,
)

/**
 * 验证 discovery advert 签名与时间戳，成功返回发布者 nodeHash 与规范化后的 relay 字段。
 * @param rendezvousKey 期望的汇合键
 * @param advert 原始 advert 载荷
 * @param now 当前时间（毫秒）
 * @param maxSkewMs 允许的最大时钟偏差（毫秒）
 * @return 验证通过返回结果，失败返回 null
 */
@JvmOverloads
fun verifySignedAdvert(
	rendezvousKey: String,
	advert: Any?,
	now: Long = System.currentTimeMillis(),
	maxSkewMs: Long = 10L * 60_000,
): VerifiedAdvert? {
	val obj = advert as? Map<*, *> ?: return null
	val parsedHello = parseHello(
		linkedMapOf(
			"nodeHash" to obj["nodeHash"],
			"nodePubKey" to obj["nodePubKey"],
			"nonce" to "0".repeat(64),
		),
	) ?: return null
	val ts = (obj["ts"] as? Number)?.toDouble() ?: return null
	if (ts.isNaN() || ts.isInfinite()) return null
	val sig = isSignatureHex128(obj["sig"]) ?: return null
	if (Math.abs(now - ts) > maxSkewMs) return null
	val tcpPort = normalizeTcpPort(obj["tcpPort"])
	if (obj["tcpPort"] != null && obj["tcpPort"] !== io.github.steve02081504.fountp2p.core.JsonUndefined && tcpPort == null) return null
	val sanitized = sanitizeAdvertRelayFields(obj["nostrRelayPool"], obj["listenNostrRelays"])
	val message = buildAdvertMessage(
		rendezvousKey,
		ts,
		parsedHello["nodeHash"] as String,
		tcpPort,
		normalizeLanHosts(obj["lanHosts"]),
		canonicalAdvertRelayBlob(sanitized.pool, sanitized.listen),
	)
	if (!verify(hexToBytes(sig), message, hexToBytes(parsedHello["nodePubKey"] as String))) return null
	return VerifiedAdvert(parsedHello["nodeHash"] as String, sanitized.pool, sanitized.listen)
}
