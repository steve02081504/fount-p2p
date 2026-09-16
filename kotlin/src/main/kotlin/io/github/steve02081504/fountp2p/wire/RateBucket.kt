package io.github.steve02081504.fountp2p.wire

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.JsonObject
import io.github.steve02081504.fountp2p.utils.LruMap

/**
 * 60 秒令牌桶限速（fed_chunk / fed_emoji 等 want-data 线共用）。
 *
 * 等价 `js/wire/rate_bucket.mjs`。为避免依赖全局时钟，[consumeWireRateBucket]
 * 额外提供 `now` 参数（默认 [System.currentTimeMillis]）以便测试注入。
 */

private const val WINDOW_MS = 60_000.0
private const val BUCKET_MAP_MAX = 5000

/** 单个桶状态。 */
class WireRateBucketState(var tokens: Double, var bytes: Double, var lastRefill: Long)

private val buckets = LruMap<String, WireRateBucketState>(BUCKET_MAP_MAX)

/**
 * @param bucketKey 房间或资源键
 * @param limits 限额（`maxCount` / `byteCount?` / `maxBytesPerWindow?`）
 * @param now 当前时间戳（ms）
 * @return 是否允许本次消费
 */
fun consumeWireRateBucket(
	bucketKey: String,
	limits: JsonObject,
	now: Long = System.currentTimeMillis(),
): Boolean {
	val byteCount = maxOf(0.0, Json.num(limits["byteCount"]) ?: 0.0)
	val maxBytes = Json.num(limits["maxBytesPerWindow"]) ?: 0.0
	val maxCount = Json.num(limits["maxCount"]) ?: Double.NaN
	var bucket = buckets[bucketKey]
	if (bucket == null) {
		bucket = WireRateBucketState(
			tokens = maxCount,
			bytes = if (maxBytes > 0) maxBytes else Double.POSITIVE_INFINITY,
			lastRefill = now,
		)
		buckets.touch(bucketKey, bucket)
	}
	else buckets.touch(bucketKey, bucket)
	val elapsed = (now - bucket.lastRefill).toDouble()
	if (elapsed > 0) {
		val rate = maxCount / WINDOW_MS
		bucket.tokens = minOf(maxCount, bucket.tokens + elapsed * rate)
		if (maxBytes > 0) {
			val byteRate = maxBytes / WINDOW_MS
			bucket.bytes = minOf(maxBytes, bucket.bytes + elapsed * byteRate)
		}
		bucket.lastRefill = now
	}
	if (bucket.tokens < 1) return false
	if (maxBytes > 0 && bucket.bytes < byteCount) return false
	bucket.tokens -= 1
	if (maxBytes > 0) bucket.bytes -= byteCount
	buckets.touch(bucketKey, bucket)
	return true
}
