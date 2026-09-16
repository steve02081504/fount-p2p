package io.github.steve02081504.fountp2p.utils

/**
 * 带 `touch` 的 LRU Map（等价 JS `createLruMap`）。
 * @param max 最大条目
 */
class LruMap<K, V>(private val max: Int) {
	private val map = LinkedHashMap<K, V>()

	val size: Int get() = map.size

	operator fun get(key: K): V? = map[key]

	operator fun contains(key: K): Boolean = map.containsKey(key)

	/** 直接写入（不移动既有键）。 */
	fun put(key: K, value: V) {
		map[key] = value
		evict()
	}

	/** 写入并移动到队尾。 */
	fun touch(key: K, value: V) {
		map.remove(key)
		map[key] = value
		evict()
	}

	/** 删除键（等价 JS `Map.delete`）。 */
	fun remove(key: K) {
		map.remove(key)
	}

	fun clear() = map.clear()

	fun keys(): List<K> = map.keys.toList()

	fun values(): List<V> = map.values.toList()

	private fun evict() {
		while (map.size > max) {
			val oldest = map.keys.firstOrNull() ?: return
			map.remove(oldest)
		}
	}
}
