package io.github.steve02081504.fountp2p.utils

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * 有界 pending fetch 等待表（chunk / manifest 等入站响应槽）。
 */

private val fetchWaitScheduler = Executors.newScheduledThreadPool(1) { runnable ->
	Thread(runnable, "fount-p2p-fetch-wait").apply { isDaemon = true }
}

/** 等待句柄。 */
class FetchWaitHandle<T>(val done: Deferred<T?>, val cancel: () -> Unit)

/**
 * @param maxSize 容量
 */
class FetchWaitTable<T>(private val maxSize: Int) {
	/** 等待条目。 */
	inner class Pending internal constructor(
		val expectedKey: String,
		val options: Map<String, Any?>,
		val deferred: CompletableDeferred<T?>,
	) {
		var timeout: ScheduledFuture<*>? = null

		internal fun finish(value: Any?) {
			if (value is Throwable) deferred.completeExceptionally(value)
			else {
				@Suppress("UNCHECKED_CAST")
				deferred.complete(value as T?)
			}
		}
	}

	val pending = LinkedHashMap<String, Pending>()

	private fun handleOf(key: String, entry: Pending): FetchWaitHandle<T> =
		FetchWaitHandle(entry.deferred) { settle(key, null) }

	/**
	 * @param key 唯一等待键
	 * @param expectedKey 期望匹配键
	 * @param timeoutMs 超时
	 * @param options 可扩展等待选项（rejectOnTimeout 由本表消费）
	 * @return 等待句柄
	 */
	fun register(
		key: String,
		expectedKey: String,
		timeoutMs: Long,
		options: Map<String, Any?> = emptyMap(),
	): FetchWaitHandle<T> {
		if (key.isEmpty()) return FetchWaitHandle(CompletableDeferred<T?>(null)) {}

		pending[key]?.let { return handleOf(key, it) }
		if (pending.size >= maxSize) return FetchWaitHandle(CompletableDeferred<T?>(null)) {}

		val deferred = CompletableDeferred<T?>()
		val entry = Pending(expectedKey, options, deferred)
		val handle = FetchWaitHandle<T>(deferred) { settle(key, null) }
		entry.timeout = fetchWaitScheduler.schedule({
			pending.remove(key)
			if (options["rejectOnTimeout"] == true) entry.finish(RuntimeException("fetch timeout"))
			else entry.finish(null)
		}, timeoutMs, TimeUnit.MILLISECONDS)
		pending[key] = entry
		return handle
	}

	/**
	 * 只读查看，不移除。
	 * @param key 等待键
	 * @return 等待条目
	 */
	fun peek(key: String): Pending? = pending[key]

	/**
	 * @param key 等待键
	 * @param value 结果或错误
	 * @return 是否命中并完成
	 */
	fun settle(key: String, value: Any?): Boolean {
		val entry = pending.remove(key) ?: return false
		entry.timeout?.cancel(false)
		entry.finish(value)
		return true
	}
}
