package io.github.steve02081504.fountp2p.federation

import io.github.steve02081504.fountp2p.utils.LruMap

/**
 * TTL 去重槽：partition bridge、gossip 等共用。
 * @param maxSize 容量上限
 * @param ttlMs TTL 毫秒
 * @param now 当前时间戳提供者（测试可注入）
 */
class DedupeSlot(
	private val maxSize: Int = 2000,
	private val ttlMs: Long = 30_000,
	private val now: () -> Long = System::currentTimeMillis,
) {
	private val seen = LruMap<String, Long>(maxSize)

	/**
	 * @param key 去重键
	 * @return 首次占用返回 true
	 */
	fun take(key: String): Boolean {
		val current = now()
		val seenAt = seen[key]
		if (seenAt != null) {
			if (current - seenAt < ttlMs) return false
			seen.remove(key)
		}
		seen.touch(key, current)
		return true
	}
}

/**
 * @param options `maxSize` / `ttlMs` 覆盖
 * @param now 当前时间戳提供者
 * @return TTL 去重槽
 */
fun createDedupeSlot(options: Map<String, Any?> = emptyMap(), now: (() -> Long)? = null): DedupeSlot {
	val maxSize = jsNumberOr(jsNumber(options["maxSize"]), 2000.0)
	val ttlMs = jsNumberOr(jsNumber(options["ttlMs"]), 30_000.0)
	return DedupeSlot(maxSize.toInt(), ttlMs.toLong(), now ?: System::currentTimeMillis)
}
