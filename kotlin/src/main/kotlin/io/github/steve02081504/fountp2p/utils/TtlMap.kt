package io.github.steve02081504.fountp2p.utils

/**
 * 带 TTL 的 Map：get 时惰性过期；set 时在超上限下先清过期再 LRU 驱逐。
 * @param ttlMs 存活毫秒
 * @param maxSize 最大条目（防只写不读时过期项堆积）
 */
class TtlMap<T>(val ttlMs: Long, maxSize: Long = 4096) {
	private class Entry<T>(val value: T, val seenAt: Long)

	val maxSize: Int = maxOf(1, maxSize.toInt())
	private val map = LinkedHashMap<String, Entry<T>>()

	/** @return 当前条目数（含未 get 的过期项） */
	fun size(): Int = map.size

	/** 删除过期项；若仍满则按插入序驱逐最旧。 */
	private fun prune(now: Long) {
		val iterator = map.entries.iterator()
		while (iterator.hasNext()) {
			val entry = iterator.next()
			if (now - entry.value.seenAt > ttlMs) iterator.remove()
		}
		while (map.size >= maxSize) {
			val oldest = map.keys.firstOrNull() ?: break
			map.remove(oldest)
		}
	}

	/**
	 * @param key 键
	 * @param value 值
	 */
	fun set(key: String, value: T) {
		val now = System.currentTimeMillis()
		map.remove(key)
		if (map.size >= maxSize) prune(now)
		map[key] = Entry(value, now)
	}

	/**
	 * @param key 键
	 * @param now 当前时间（测试可注入）
	 * @return 未过期值，否则 null
	 */
	fun get(key: String, now: Long = System.currentTimeMillis()): T? {
		val entry = map[key] ?: return null
		if (now - entry.seenAt > ttlMs) {
			map.remove(key)
			return null
		}
		return entry.value
	}

	/** 清空全部条目 */
	fun clear() = map.clear()
}
