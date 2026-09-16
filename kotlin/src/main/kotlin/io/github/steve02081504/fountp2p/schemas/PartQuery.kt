package io.github.steve02081504.fountp2p.schemas

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.canonicalStringify
import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.core.isPlainObject
import io.github.steve02081504.fountp2p.core.isSignatureHex128
import io.github.steve02081504.fountp2p.core.parsePartpath

/** `schemas/part_query.tunables.json`。 */
object PartQueryTunables {
	const val maxTtl: Int = 3
	const val maxHits: Int = 32
	const val maxQueryBytes: Int = 2048
	const val maxRowsBytes: Int = 16384
	const val fanoutCap: Int = 4
	const val ratePerSourcePerMin: Int = 30
	const val dedupeTtlMs: Long = 300000
	const val dedupeMaxSize: Int = 4000
	const val cacheTtlMs: Long = 300000
	const val cacheMaxKeys: Int = 256
	val hopTimeoutMs: List<Long> = listOf(1000, 2500, 4000, 6000)
	const val defaultTimeoutMs: Long = 4000
}

/**
 * @param value 任意 JSON
 * @return UTF-8 序列化字节数；不可序列化时 Infinity
 */
fun measureJsonBytes(value: Any?): Double {
	val text = Json.stringify(value) ?: return Double.POSITIVE_INFINITY
	return text.toByteArray(Charsets.UTF_8).size.toDouble()
}

/**
 * @param budget 请求预算
 * @param maxHits 上限
 * @return 钳制后的预算
 */
fun clampPartQueryBudget(budget: Any?, maxHits: Int = PartQueryTunables.maxHits): Map<String, Any?> {
	val cap = maxOf(1, maxHits)
	val raw = if (isPlainObject(budget)) Json.num((budget as Map<*, *>)["maxHits"]) else null
	val hits = if (raw != null && raw.isFinite()) Math.floor(raw).toLong() else cap.toLong()
	return mapOf("maxHits" to maxOf(1L, minOf(cap.toLong(), hits)))
}

/**
 * @param ttl 跳数预算
 * @param maxTtl 上限
 * @return 钳制后的 ttl；非法为 null
 */
fun clampPartQueryTtl(ttl: Any?, maxTtl: Int = PartQueryTunables.maxTtl): Int? {
	val cap = maxOf(1, maxTtl)
	val raw = Json.num(ttl)
	if (raw == null || !raw.isFinite()) return null
	val n = Math.floor(raw).toLong()
	if (n < 1) return null
	return minOf(cap.toLong(), n).toInt()
}

/**
 * @param rows 行数组
 * @param maxHits 条数上限
 * @param maxRowsBytes 总尺寸上限
 * @return 通过校验的 rows；失败 null
 */
fun clampPartQueryRows(rows: Any?, maxHits: Number, maxRowsBytes: Int = PartQueryTunables.maxRowsBytes): List<Any?>? {
	if (rows !is List<*>) return null
	val limit = maxOf(0L, Math.floor(maxHits.toDouble()).toLong())
	val limited = rows.take(limit.coerceAtMost(Int.MAX_VALUE.toLong()).toInt())
	if (measureJsonBytes(limited) > maxRowsBytes) return null
	return limited
}

/** requestId 上限（randomUUID 36 字符；防超长键灌爆 dedupe/pending 表） */
private const val REQUEST_ID_MAX_LENGTH = 128

/**
 * @param value 原始 requestId
 * @return 合法 requestId；非法 null
 */
private fun normalizeRequestId(value: Any?): String? {
	val requestId = (value as? String) ?: if (value == null) "" else value.toString()
	if (requestId.isEmpty() || requestId.length > REQUEST_ID_MAX_LENGTH) return null
	return requestId
}

/**
 * @param value 入站 req
 * @param tunables 可调参数
 * @return 校验通过的 req；非法 null
 */
fun parsePartQueryReq(value: Any?, tunables: Map<String, Any?>? = null): Map<String, Any?>? {
	if (!isPlainObject(value)) return null
	@Suppress("UNCHECKED_CAST")
	val map = value as Map<String, Any?>
	val requestId = normalizeRequestId(map["requestId"]) ?: return null
	val originNodeHash = isHex64(map["originNodeHash"]) ?: return null
	val partpath = parsePartpath(map["partpath"]) ?: return null
	val kind = (map["kind"] as? String).orEmpty()
	if (kind.isEmpty()) return null
	if (!map.containsKey("query")) return null
	val maxQueryBytes = Json.num(tunables?.get("maxQueryBytes"))?.toInt() ?: PartQueryTunables.maxQueryBytes
	if (measureJsonBytes(map["query"]) > (maxQueryBytes.coerceAtLeast(0))) return null
	val maxTtl = Json.num(tunables?.get("maxTtl"))?.toInt() ?: PartQueryTunables.maxTtl
	val ttl = clampPartQueryTtl(map["ttl"], maxTtl) ?: return null
	val maxHits = Json.num(tunables?.get("maxHits"))?.toInt() ?: PartQueryTunables.maxHits
	val budget = clampPartQueryBudget(map["budget"], maxHits)
	return mapOf(
		"requestId" to requestId,
		"originNodeHash" to originNodeHash,
		"partpath" to partpath,
		"kind" to kind,
		"query" to map["query"],
		"ttl" to ttl,
		"budget" to budget,
	)
}

/**
 * @param value 入站 res
 * @param tunables 可调参数
 * @return 校验通过的 res；非法 null
 */
fun parsePartQueryRes(value: Any?, tunables: Map<String, Any?>? = null): Map<String, Any?>? {
	if (!isPlainObject(value)) return null
	@Suppress("UNCHECKED_CAST")
	val map = value as Map<String, Any?>
	val requestId = normalizeRequestId(map["requestId"]) ?: return null
	val fromNodeHash = isHex64(map["fromNodeHash"]) ?: return null
	// 响应必须自证来源：nodePubKey 的哈希即 fromNodeHash，sig 覆盖 (requestId, fromNodeHash, rows)。
	val nodePubKey = isHex64(map["nodePubKey"]) ?: return null
	val sig = isSignatureHex128(map["sig"]) ?: return null
	val maxHits = Json.num(tunables?.get("maxHits"))?.toInt() ?: PartQueryTunables.maxHits
	val maxRowsBytes = Json.num(tunables?.get("maxRowsBytes"))?.toInt() ?: PartQueryTunables.maxRowsBytes
	val rows = clampPartQueryRows(map["rows"], maxHits, maxRowsBytes) ?: return null
	return mapOf(
		"requestId" to requestId,
		"fromNodeHash" to fromNodeHash,
		"rows" to rows,
		"nodePubKey" to nodePubKey,
		"sig" to sig,
	)
}

/**
 * @param partpath part 路径
 * @param kind 查询标签
 * @param query 不透明查询
 * @return 规范化三元组的缓存材料；非法 null
 */
fun normalizePartQueryCacheMaterial(partpath: Any?, kind: Any?, query: Any?): String? {
	val path = parsePartpath(partpath) ?: return null
	val k = (kind as? String).orEmpty()
	if (k.isEmpty()) return null
	if (measureJsonBytes(query) > PartQueryTunables.maxQueryBytes) return null
	return try {
		canonicalStringify(mapOf("partpath" to path, "kind" to k, "query" to query))
	}
	catch (_: Exception) {
		null
	}
}
