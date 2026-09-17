package io.github.steve02081504.fountp2p.mailbox

import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.federation.jsNumber
import io.github.steve02081504.fountp2p.federation.jsNumberOr

/**
 * Mailbox 入站 put 限速（按来源节点，节点级单例）。
 *
 * 等价 `js/mailbox/rate.mjs`。JS 单线程天然串行；Kotlin 侧对 LRU 状态加锁保证原子。
 */

private const val DEFAULT_WINDOW_MS = 60_000.0
private const val DEFAULT_MAX_PUTS = 20.0
private const val MAX_KEYS = 8000
private const val EXPIRE_SWEEP_BATCH = 64

/** 单键限速状态。 */
private class RateEntry(var count: Double, var resetAt: Double)

private val inboundByKey = LinkedHashMap<String, RateEntry>()
private val inboundGuard = Any()

/**
 * @param limits 可选限额
 * @return 生效限额（windowMs / maxPuts）
 */
private fun resolveMailboxRateLimits(limits: Map<String, Any?>?): Pair<Double, Double> {
	val windowMs = maxOf(1000.0, jsNumberOr(jsNumber(limits?.get("windowMs")), DEFAULT_WINDOW_MS))
	val maxPuts = maxOf(1.0, minOf(256.0, jsNumberOr(jsNumber(limits?.get("maxPuts")), DEFAULT_MAX_PUTS)))
	return windowMs to maxPuts
}

/**
 * @param now 当前时间戳
 */
private fun sweepExpiredEntries(now: Double) {
	var scanned = 0
	val iterator = inboundByKey.entries.iterator()
	while (iterator.hasNext()) {
		val entry = iterator.next()
		if (now > entry.value.resetAt) iterator.remove()
		if (++scanned >= EXPIRE_SWEEP_BATCH) break
	}
}

/**
 * @param key 限速键
 */
private fun touchLruKey(key: String) {
	val entry = inboundByKey.remove(key) ?: return
	inboundByKey[key] = entry
}

/**
 * @param key 新插入键
 */
private fun evictLruIfNeeded(key: String) {
	if (inboundByKey.containsKey(key) || inboundByKey.size < MAX_KEYS) return
	val oldest = inboundByKey.keys.firstOrNull() ?: return
	inboundByKey.remove(oldest)
}

/**
 * @param fromNodeHash 来源节点
 * @param limits 可选限额
 * @return 允许新 put 则为 true
 */
fun takeIncomingMailboxPutSlot(fromNodeHash: Any?, limits: Map<String, Any?>? = null): Boolean {
	val (windowMs, maxPuts) = resolveMailboxRateLimits(limits)
	val key = fromNodeHash as? String ?: return false
	if (isHex64(key) == null) return false
	synchronized(inboundGuard) {
		val now = System.currentTimeMillis().toDouble()
		if (inboundByKey.size >= MAX_KEYS) sweepExpiredEntries(now)
		evictLruIfNeeded(key)
		var entry = inboundByKey[key]
		if (entry == null || now > entry.resetAt) entry = RateEntry(0.0, now + windowMs)
		if (entry.count >= maxPuts) {
			touchLruKey(key)
			return false
		}
		entry.count++
		inboundByKey[key] = entry
		touchLruKey(key)
		return true
	}
}
