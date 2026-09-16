package io.github.steve02081504.fountp2p.federation

/**
 * wantIds 限速与退避（§9）：每邻居 QPS/突发、出站批预算、指数退避冷却。
 */

private const val DEFAULT_IN_WINDOW_MS = 60_000.0
private const val DEFAULT_IN_MAX_BATCH = 32.0
private const val DEFAULT_OUT_WINDOW_MS = 60_000.0
private const val DEFAULT_OUT_MAX_BATCH = 16.0
private const val DEFAULT_BACKOFF_BASE_MS = 2_000.0
private const val DEFAULT_BACKOFF_MAX_MS = 120_000.0

private class RateEntry(var count: Int, var resetAt: Long)
private class BackoffEntry(var until: Long, var strikes: Int)

private val inboundByKey = HashMap<String, RateEntry>()
private val outboundByKey = HashMap<String, RateEntry>()
private val backoffByKey = HashMap<String, BackoffEntry>()

/**
 * 清理过期速率窗口条目。
 * @param map 速率表
 * @param maxSize 触发清理的上限
 * @param now 当前时间戳
 */
private fun pruneRateMap(map: HashMap<String, RateEntry>, maxSize: Int, now: Long) {
	if (map.size <= maxSize) return
	val iterator = map.entries.iterator()
	while (iterator.hasNext()) {
		val entry = iterator.next().value
		if (now > entry.resetAt + 120_000) iterator.remove()
	}
}

/**
 * 解析 wantIds 限速参数。
 * @param limits 可选覆盖
 * @return 生效限额
 */
fun resolveWantIdsLimits(limits: Map<String, Any?>? = null): Map<String, Any?> = linkedMapOf(
	"inWindowMs" to maxOf(1000.0, jsNumberOr(jsNumber(limits?.get("inWindowMs")), DEFAULT_IN_WINDOW_MS)),
	"inMaxBatch" to maxOf(1.0, minOf(256.0, jsNumberOr(jsNumber(limits?.get("inMaxBatch")), DEFAULT_IN_MAX_BATCH))),
	"outWindowMs" to maxOf(1000.0, jsNumberOr(jsNumber(limits?.get("outWindowMs")), DEFAULT_OUT_WINDOW_MS)),
	"outMaxBatch" to maxOf(1.0, minOf(256.0, jsNumberOr(jsNumber(limits?.get("outMaxBatch")), DEFAULT_OUT_MAX_BATCH))),
)

/**
 * @param groupId 群 ID
 * @param peerId 对端节点 id
 * @return 复合键
 */
fun wantIdsPeerKey(groupId: String, peerId: String): String = "$groupId\u0000$peerId"

/**
 * 出站 want 限速键。
 * @param groupId 群 ID
 * @return 复合键
 */
fun wantIdsGroupKey(groupId: String): String = groupId

/**
 * 是否处于 wantIds 退避冷却。
 * @param key 限速或退避键
 * @param now 当前时间戳
 * @return 冷却中则为 true
 */
fun isWantIdsInBackoff(key: String, now: Long = System.currentTimeMillis()): Boolean {
	val backoff = backoffByKey[key] ?: return false
	if (now < backoff.until) return true
	backoffByKey.remove(key)
	return false
}

/**
 * 记录一次 wantIds 超限并延长退避。
 * @param key 退避键
 * @param now 当前时间戳
 */
fun recordWantIdsBackoff(key: String, now: Long = System.currentTimeMillis()) {
	val strikes = (backoffByKey[key]?.strikes ?: 0) + 1
	val delay = minOf(
		DEFAULT_BACKOFF_MAX_MS,
		DEFAULT_BACKOFF_BASE_MS * Math.pow(2.0, minOf(strikes - 1, 6).toDouble()),
	)
	backoffByKey[key] = BackoffEntry(now + delay.toLong(), strikes)
	if (backoffByKey.size > 12_000) {
		val iterator = backoffByKey.entries.iterator()
		while (iterator.hasNext()) {
			if (now > iterator.next().value.until) iterator.remove()
		}
	}
}

/**
 * 消耗入站 want 配额。
 * @param groupId 群 ID
 * @param requesterId 请求方节点 id
 * @param limits 可选限额
 * @param now 当前时间戳
 * @return 允许处理则为 true
 */
fun takeIncomingWantIdsSlot(
	groupId: String,
	requesterId: String,
	limits: Map<String, Any?>? = null,
	now: Long = System.currentTimeMillis(),
): Boolean {
	val resolved = resolveWantIdsLimits(limits)
	val inWindowMs = (resolved["inWindowMs"] as Number).toLong()
	val inMaxBatch = (resolved["inMaxBatch"] as Number).toInt()
	val peerKey = wantIdsPeerKey(groupId, requesterId)
	if (isWantIdsInBackoff(peerKey, now)) return false
	var entry = inboundByKey[peerKey]
	if (entry == null || now > entry.resetAt) entry = RateEntry(0, now + inWindowMs)
	if (entry.count >= inMaxBatch) {
		recordWantIdsBackoff(peerKey, now)
		return false
	}
	entry.count++
	inboundByKey[peerKey] = entry
	pruneRateMap(inboundByKey, 8000, now)
	return true
}

/**
 * 消耗出站 want 配额。
 * @param groupId 群 ID
 * @param limits 可选限额
 * @param now 当前时间戳
 * @return 允许发起则为 true
 */
fun takeOutgoingWantIdsSlot(
	groupId: String,
	limits: Map<String, Any?>? = null,
	now: Long = System.currentTimeMillis(),
): Boolean {
	val resolved = resolveWantIdsLimits(limits)
	val outWindowMs = (resolved["outWindowMs"] as Number).toLong()
	val outMaxBatch = (resolved["outMaxBatch"] as Number).toInt()
	val key = wantIdsGroupKey(groupId)
	if (isWantIdsInBackoff(key, now)) return false
	var entry = outboundByKey[key]
	if (entry == null || now > entry.resetAt) entry = RateEntry(0, now + outWindowMs)
	if (entry.count >= outMaxBatch) {
		recordWantIdsBackoff(key, now)
		return false
	}
	entry.count++
	outboundByKey[key] = entry
	pruneRateMap(outboundByKey, 4000, now)
	return true
}

/**
 * 按预算截断 wantIds 列表。
 * @param wantIds 缺失事件 id
 * @param budget 单批上限
 * @return 截断后的 id 列表
 */
fun batchWantIds(wantIds: List<String>, budget: Any?): List<String> {
	val cap = maxOf(1.0, minOf(256.0, jsNumberOr(jsNumber(budget), DEFAULT_OUT_MAX_BATCH))).toInt()
	return wantIds.take(cap)
}
