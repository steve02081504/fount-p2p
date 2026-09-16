package io.github.steve02081504.fountp2p.wire

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Trystero 请求-响应等待表（gossip、channel history 等共用）。
 *
 * 等价 `js/wire/wait.mjs`。JS 用 `setTimeout`/`Promise`；此处用共享调度器 +
 * [CompletableDeferred]（与 `utils/FetchWait` 一致）。
 */

private val wireWaitScheduler = Executors.newScheduledThreadPool(1) { runnable ->
	Thread(runnable, "fount-p2p-wire-wait").apply { isDaemon = true }
}

/** 等待条目：`resolve` 可带值（对应 JS `WireWaiter.resolve(value?)`）。 */
class WireWaiter(val resolve: (Any?) -> Unit) {
	var timer: ScheduledFuture<*>? = null
}

/** [registerWireWait] 返回的等待句柄。 */
class WireWaitHandle(val resolve: (Any?) -> Unit, val promise: Deferred<Any?>)

/**
 * @param pending 等待表
 * @param key 等待键
 * @param timeoutMs 超时毫秒
 * @param onTimeout 超时回调值
 * @return 等待句柄
 */
fun registerWireWait(
	pending: MutableMap<String, WireWaiter>,
	key: String,
	timeoutMs: Long,
	onTimeout: () -> Any?,
): WireWaitHandle {
	val deferred = CompletableDeferred<Any?>()
	lateinit var waiter: WireWaiter
	val timer = wireWaitScheduler.schedule({
		pending.remove(key)
		deferred.complete(onTimeout())
	}, timeoutMs, TimeUnit.MILLISECONDS)
	waiter = WireWaiter { value ->
		timer.cancel(false)
		pending.remove(key)
		deferred.complete(value)
	}
	waiter.timer = timer
	pending[key] = waiter
	return WireWaitHandle(waiter.resolve, deferred)
}

private fun ensurePrefixBucket(
	pending: MutableMap<String, MutableMap<String, MutableList<WireWaiter>>>,
	keyPrefix: String,
): MutableMap<String, MutableList<WireWaiter>> = pending.getOrPut(keyPrefix) { LinkedHashMap() }

/**
 * 多 waiter 注册（gossip 等同键并发等待）。
 * @param pending 多 waiter 表
 * @param keyPrefix 键前缀
 * @param suffixKey 后缀键
 * @param timeoutMs 超时毫秒
 * @param onTimeout 超时返回值
 * @return 完成 promise
 */
fun registerMultiWireWait(
	pending: MutableMap<String, MutableMap<String, MutableList<WireWaiter>>>,
	keyPrefix: String,
	suffixKey: String,
	timeoutMs: Long,
	onTimeout: () -> Any? = { null },
): Deferred<Any?> {
	val deferred = CompletableDeferred<Any?>()
	val timer = wireWaitScheduler.schedule({
		finishMultiWireWaiters(pending, keyPrefix, suffixKey)
		deferred.complete(onTimeout())
	}, timeoutMs, TimeUnit.MILLISECONDS)
	val waiter = WireWaiter { deferred.complete(null) }
	waiter.timer = timer
	val bucket = ensurePrefixBucket(pending, keyPrefix)
	bucket.getOrPut(suffixKey) { mutableListOf() }.add(waiter)
	return deferred
}

/**
 * @param pending 多 waiter 表
 * @param keyPrefix 键前缀
 * @param suffixKey 后缀键
 */
fun finishMultiWireWaiters(
	pending: MutableMap<String, MutableMap<String, MutableList<WireWaiter>>>,
	keyPrefix: String,
	suffixKey: String,
) {
	val bucket = pending[keyPrefix] ?: return
	val waiters = bucket[suffixKey]
	if (waiters == null || waiters.isEmpty()) return
	bucket.remove(suffixKey)
	if (bucket.isEmpty()) pending.remove(keyPrefix)
	for (waiter in waiters) {
		waiter.timer?.cancel(false)
		waiter.resolve(null)
	}
}

/**
 * 前缀桶内按 want id 命中唤醒 waiter。
 * @param pending 多 waiter 表
 * @param keyPrefix 键前缀
 * @param hitIds 命中 id 集合
 * @param parseWantIds 从后缀键解析 want id 列表
 */
fun notifyMultiWireWaitersByPrefix(
	pending: MutableMap<String, MutableMap<String, MutableList<WireWaiter>>>,
	keyPrefix: String,
	hitIds: Set<String>,
	parseWantIds: (suffixKey: String) -> List<String>?,
) {
	if (hitIds.isEmpty()) return
	val bucket = pending[keyPrefix] ?: return
	for ((suffixKey, waiters) in bucket.entries.toList()) {
		val wanted = parseWantIds(suffixKey)
		if (wanted.isNullOrEmpty()) continue
		if (wanted.none { it in hitIds }) continue
		bucket.remove(suffixKey)
		for (waiter in waiters) {
			waiter.timer?.cancel(false)
			waiter.resolve(null)
		}
	}
	if (bucket.isEmpty()) pending.remove(keyPrefix)
}
