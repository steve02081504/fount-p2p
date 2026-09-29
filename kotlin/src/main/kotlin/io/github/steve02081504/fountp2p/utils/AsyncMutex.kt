package io.github.steve02081504.fountp2p.utils

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * 进程内 per-key 异步互斥锁（队列式）。
 *
 * 引用计数：键在第一个调用者进入时创建，最后一个调用者离开时移除，
 * 避免 [mutexes] 随用过的键无限增长（JS 等价实现同样在 release 时删除）。
 */
private class MutexEntry {
	val mutex = Mutex()
	var users = 0
}

private val mutexes = HashMap<String, MutexEntry>()
private val mutexesGuard = Any()

/**
 * @param key 锁键
 * @param criticalSection 临界区
 * @return `criticalSection` 的返回值
 */
suspend fun <T> withAsyncMutex(key: String, criticalSection: suspend () -> T): T {
	val entry = synchronized(mutexesGuard) {
		val existing = mutexes.getOrPut(key) { MutexEntry() }
		existing.users++
		existing
	}
	try {
		return entry.mutex.withLock { criticalSection() }
	}
	finally {
		synchronized(mutexesGuard) {
			entry.users--
			if (entry.users == 0) mutexes.remove(key, entry)
		}
	}
}

/**
 * 当前未释放的锁键数量（测试用）。
 * @return [mutexes] 大小
 */
internal fun asyncMutexCount(): Int = synchronized(mutexesGuard) { mutexes.size }
