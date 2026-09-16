package io.github.steve02081504.fountp2p.schemas

import io.github.steve02081504.fountp2p.core.assertHex64
import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.core.isPlainObject
import io.github.steve02081504.fountp2p.core.isSignatureHex128

private const val MAX_DISCOVERY_ADS = 64

/**
 * @param ad 单条 discovery 广告
 * @return 白名单字段（保持 JS 属性顺序）；非法 null
 */
fun sanitizeDiscoveryAdvertisement(ad: Any?): Map<String, Any?>? {
	if (!isPlainObject(ad)) return null
	@Suppress("UNCHECKED_CAST")
	val map = ad as Map<String, Any?>
	val groupId = (map["groupId"] as? String).orEmpty()
	val advertiserPubKeyHash = isHex64(map["advertiserPubKeyHash"]) ?: return null
	val signature = isSignatureHex128(map["signature"]) ?: return null
	if (groupId.isEmpty()) return null
	val body = LinkedHashMap<String, Any?>()
	body["groupId"] = groupId
	body["title"] = (map["title"] as? String).orEmpty().take(200)
	body["blurb"] = (map["blurb"] as? String).orEmpty().take(500)
	body["advertiserPubKeyHash"] = advertiserPubKeyHash
	body["advertiserNodeHash"] = isHex64(map["advertiserNodeHash"]) ?: ""
	body["observedAt"] = io.github.steve02081504.fountp2p.core.Json.num(map["observedAt"]) ?: 0.0
	body["signature"] = signature
	val memberCount = io.github.steve02081504.fountp2p.core.Json.num(map["memberCount"])
	if (memberCount != null && memberCount.isFinite() && memberCount > 0)
		body["memberCount"] = Math.floor(memberCount).toLong()
	return body
}

/**
 * @param ads advertisements 数组
 * @return 已清扫广告
 */
fun sanitizeDiscoveryAdvertisements(ads: Any?): List<Map<String, Any?>> {
	val list = ads as? List<*> ?: return emptyList()
	return list.take(MAX_DISCOVERY_ADS).mapNotNull { sanitizeDiscoveryAdvertisement(it) }
}

/**
 * @param nodeHash 节点 hash
 * @return 规范化 hex64
 */
fun assertDiscoveryNodeHash(nodeHash: Any?): String = assertHex64(nodeHash, "discovery.nodeHash")

/**
 * @param requestId 请求 id
 * @return 非空字符串
 */
fun assertDiscoveryRequestId(requestId: Any?): String {
	val id = requestId?.toString() ?: ""
	if (id.isEmpty()) throw IllegalArgumentException("discovery.requestId required")
	return id
}

/**
 * @param payload 载荷
 * @return 解析结果；非法 null
 */
fun parseDiscoveryAnnounce(payload: Any?): Map<String, Any?>? {
	if (!isPlainObject(payload)) return null
	@Suppress("UNCHECKED_CAST")
	val map = payload as Map<String, Any?>
	return try {
		mapOf(
			"nodeHash" to assertDiscoveryNodeHash(map["nodeHash"]),
			"advertisements" to sanitizeDiscoveryAdvertisements(map["advertisements"]),
		)
	}
	catch (_: Exception) {
		null
	}
}

/**
 * @param payload 载荷
 * @return 解析结果；非法 null
 */
fun parseDiscoveryQuery(payload: Any?): Map<String, Any?>? {
	if (!isPlainObject(payload)) return null
	@Suppress("UNCHECKED_CAST")
	val map = payload as Map<String, Any?>
	return try {
		val limit = (io.github.steve02081504.fountp2p.core.Json.num(map["limit"]) ?: 0.0).toLong()
		mapOf(
			"nodeHash" to assertDiscoveryNodeHash(map["nodeHash"]),
			"requestId" to assertDiscoveryRequestId(map["requestId"]),
			"limit" to minOf(64L, maxOf(1L, limit)),
		)
	}
	catch (_: Exception) {
		null
	}
}

/**
 * @param payload 载荷
 * @return 解析结果；非法 null
 */
fun parseDiscoveryQueryResponse(payload: Any?): Map<String, Any?>? {
	if (!isPlainObject(payload)) return null
	@Suppress("UNCHECKED_CAST")
	val map = payload as Map<String, Any?>
	return try {
		mapOf(
			"requestId" to assertDiscoveryRequestId(map["requestId"]),
			"nodeHash" to assertDiscoveryNodeHash(map["nodeHash"]),
			"advertisements" to sanitizeDiscoveryAdvertisements(map["advertisements"]),
		)
	}
	catch (_: Exception) {
		null
	}
}
