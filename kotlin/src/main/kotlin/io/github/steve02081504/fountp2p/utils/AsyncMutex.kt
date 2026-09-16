package io.github.steve02081504.fountp2p.utils

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * 进程内 per-key 异步互斥锁（队列式）。
 */
private val mutexes = HashMap<String, Mutex>()
private val mutexesGuard = Any()

/**
 * @param key 锁键
 * @param criticalSection 临界区
 * @return `criticalSection` 的返回值
 */
suspend fun <T> withAsyncMutex(key: String, criticalSection: suspend () -> T): T {
	val mutex = synchronized(mutexesGuard) { mutexes.getOrPut(key) { Mutex() } }
	return mutex.withLock { criticalSection() }
}
