package io.github.steve02081504.fountp2p.utils

import kotlinx.coroutines.Deferred

/** 由 [InflightTable.acquire] 启动的在飞任务句柄。 */
class Started<T>(val done: Deferred<T>, val cancel: () -> Unit)

/**
 * In-flight 去重表：同 key 复用并 touch 到队尾；队满时仅淘汰「已超过 baseTimeout」的队首。
 * 双窗口：size >= maxSize 且 entry 年龄 >= baseTimeoutMs 才 cancel。
 */
class InflightTable<T>(
	maxSize: Number,
	baseTimeoutMs: Number,
	private val now: () -> Long = { System.currentTimeMillis() },
) {
	private val maxSize: Int = maxOf(1, Math.floor(maxSize.toDouble()).toInt())
	private val baseTimeoutMs: Long = maxOf(0L, baseTimeoutMs.toLong())

	private class Entry<T>(val done: Deferred<T>, val cancel: () -> Unit, val startedAt: Long)

	private val map = LinkedHashMap<String, Entry<T>>()

	/** @return 当前 in-flight 数 */
	fun size(): Int = map.size

	/** @param key 逻辑键 @return 是否在飞 */
	fun has(key: String): Boolean = map.containsKey(key)

	/**
	 * 复用或启动；队满且无法淘汰超时项时返回 null（拒绝新开）。
	 * @param key 逻辑键
	 * @param start 仅在未命中时调用
	 * @return 共享 Deferred，或拒绝新开
	 */
	fun acquire(key: String, start: () -> Started<T>): Deferred<T>? {
		val existing = map[key]
		if (existing != null) {
			map.remove(key)
			map[key] = existing
			pruneAgedOverCap()
			return existing.done
		}

		pruneAgedOverCap()
		if (map.size >= maxSize) return null

		val started = start()
		val entry = Entry(started.done, started.cancel, now())
		track(key, entry)
		return entry.done
	}

	private fun track(key: String, entry: Entry<T>) {
		entry.done.invokeOnCompletion { if (map[key] === entry) map.remove(key) }
		map[key] = entry
	}

	/** 队满时从队首取消已超时项。 */
	private fun pruneAgedOverCap() {
		val t = now()
		while (map.size >= maxSize) {
			val oldestKey = map.keys.firstOrNull() ?: break
			val entry = map[oldestKey] ?: break
			if (t - entry.startedAt < baseTimeoutMs) break
			map.remove(oldestKey)
			entry.cancel()
		}
	}

	/** 取消全部并清空（测试用）。 */
	fun clear() {
		for (entry in map.values.toList()) entry.cancel()
		map.clear()
	}
}
