package io.github.steve02081504.fountp2p.federation.part_query

import io.github.steve02081504.fountp2p.crypto.sha256Hex
import io.github.steve02081504.fountp2p.federation.jsNumber
import io.github.steve02081504.fountp2p.schemas.PartQueryTunables
import io.github.steve02081504.fountp2p.schemas.normalizePartQueryCacheMaterial
import io.github.steve02081504.fountp2p.utils.LruMap

/** rowKey → 来源节点集合。 */
typealias PartQuerySources = MutableMap<String, MutableSet<String>>

/** 缓存命中结果：rows 与来源集合。 */
class PartQueryCacheResult(val rows: List<Any?>, val sources: PartQuerySources)

/**
 * @param partpath part 路径
 * @param kind 查询标签
 * @param query 不透明查询
 * @return sha256 hex 缓存键；非法 null
 */
fun partQueryCacheKey(partpath: Any?, kind: Any?, query: Any?): String? {
	val material = normalizePartQueryCacheMaterial(partpath, kind, query) ?: return null
	return sha256Hex(material)
}

/**
 * LRU + TTL 中继缓存（未验证线索；发起端仍需验签复核）。
 * @param maxKeys 最大键数
 * @param ttlMs 存活毫秒
 * @param maxHits 单键 rows 上限
 */
class PartQueryCache(
	val maxKeys: Int,
	val ttlMs: Long,
	val maxHits: Int,
) {
	private class Entry(val rows: List<Any?>, val storedAt: Long, val sources: PartQuerySources)

	private val map = LruMap<String, Entry>(maxKeys)

	/** @return 当前条目数 */
	val size: Int get() = map.size

	private fun sweep(now: Long) {
		for (key in map.keys()) {
			val entry = map[key] ?: continue
			if (now - entry.storedAt >= ttlMs) map.remove(key)
		}
	}

	/**
	 * @param partpath part 路径
	 * @param kind 查询标签
	 * @param query 查询体
	 * @param now 当前时间
	 * @return 未过期 rows；未命中 null
	 */
	fun get(partpath: Any?, kind: Any?, query: Any?, now: Long = System.currentTimeMillis()): List<Any?>? =
		getWithSources(partpath, kind, query, now)?.rows

	/**
	 * @param partpath part 路径
	 * @param kind 查询标签
	 * @param query 查询体
	 * @param now 当前时间
	 * @return 未过期 rows 与来源；未命中 null
	 */
	fun getWithSources(partpath: Any?, kind: Any?, query: Any?, now: Long = System.currentTimeMillis()): PartQueryCacheResult? {
		val key = partQueryCacheKey(partpath, kind, query) ?: return null
		val entry = map[key] ?: return null
		if (now - entry.storedAt >= ttlMs) {
			map.remove(key)
			return null
		}
		map.touch(key, entry)
		return PartQueryCacheResult(entry.rows.toList(), entry.sources)
	}

	/**
	 * @param partpath part 路径
	 * @param kind 查询标签
	 * @param query 查询体
	 * @param rows 聚合 rows（空数组不入库）
	 * @param now 当前时间
	 * @param sources rowKey→来源集合
	 */
	fun set(
		partpath: Any?,
		kind: Any?,
		query: Any?,
		rows: List<Any?>?,
		now: Long = System.currentTimeMillis(),
		sources: PartQuerySources? = null,
	) {
		val key = partQueryCacheKey(partpath, kind, query)
		// 空 miss 不缓存：mesh 晚就绪 / 超时早查询不应被长 TTL 负缓存粘住
		if (key == null || rows == null || rows.isEmpty()) return
		sweep(now)
		map.touch(key, Entry(rows.take(maxHits), now, sources ?: mutableMapOf()))
	}

	fun clear() {
		map.clear()
	}
}

/**
 * @param options `maxKeys` / `ttlMs` / `maxHits` 覆盖
 * @return 缓存实例
 */
fun createPartQueryCache(options: Map<String, Any?> = emptyMap()): PartQueryCache = PartQueryCache(
	maxKeys = positiveInt(options["maxKeys"], PartQueryTunables.cacheMaxKeys),
	ttlMs = positiveLong(options["ttlMs"], PartQueryTunables.cacheTtlMs),
	maxHits = positiveInt(options["maxHits"], PartQueryTunables.maxHits),
)

private fun positiveInt(raw: Any?, fallback: Int): Int {
	val value = if (jsNumber(raw).let { it.isNaN() || it == 0.0 }) fallback.toDouble() else jsNumber(raw)
	return maxOf(1, Math.floor(value).toInt())
}

private fun positiveLong(raw: Any?, fallback: Long): Long {
	val value = if (jsNumber(raw).let { it.isNaN() || it == 0.0 }) fallback.toDouble() else jsNumber(raw)
	return maxOf(1L, Math.floor(value).toLong())
}

/** 进程内默认中继缓存 */
val partQueryCache: PartQueryCache = createPartQueryCache()
