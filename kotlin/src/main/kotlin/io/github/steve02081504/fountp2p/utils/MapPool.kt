package io.github.steve02081504.fountp2p.utils

import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * 有限并发 map（进程内，无外部依赖）。
 * @param items 待处理项
 * @param concurrency 并发上限
 * @param mapper 异步映射
 * @return 与 items 同序的结果
 */
suspend fun <T, R> mapPool(items: List<T>, concurrency: Int, mapper: suspend (T, Int) -> R): List<R> {
	if (items.isEmpty()) return emptyList()
	val limit = maxOf(1, minOf(concurrency, items.size))
	val results = arrayOfNulls<Any?>(items.size)
	var nextIndex = 0
	val indexMutex = Mutex()

	coroutineScope {
		repeat(limit) {
			launch {
				while (true) {
					val index = indexMutex.withLock {
						if (nextIndex >= items.size) -1 else nextIndex++
					}
					if (index < 0) return@launch
					results[index] = mapper(items[index], index)
				}
			}
		}
	}

	@Suppress("UNCHECKED_CAST")
	return results.map { it as R }
}
