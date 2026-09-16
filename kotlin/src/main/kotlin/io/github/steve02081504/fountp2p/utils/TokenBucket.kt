package io.github.steve02081504.fountp2p.utils

/** 令牌桶状态。 */
class TokenBucket(var tokens: Double, var updatedAt: Long)

/**
 * 令牌桶限速：桶容量 burst，补充速率 perMin/分钟。
 * @param buckets 每键桶状态
 * @param key 桶键（如发送方 nodeHash）
 * @param now 当前时间戳（ms）
 * @param perMin 每分钟补充速率
 * @param burst 桶容量
 * @return 是否允许本次消费
 */
fun consumeToken(buckets: MutableMap<String, TokenBucket>, key: String, now: Long, perMin: Long, burst: Long): Boolean {
	val p = maxOf(1, perMin)
	val b = maxOf(1, burst)
	val refillPerMs = p / 60_000.0
	var bucket = buckets[key]
	if (bucket == null) bucket = TokenBucket(b.toDouble(), now)
	val elapsed = maxOf(0L, now - bucket.updatedAt)
	bucket.tokens = minOf(b.toDouble(), bucket.tokens + elapsed * refillPerMs)
	bucket.updatedAt = now
	if (bucket.tokens < 1) {
		buckets[key] = bucket
		return false
	}
	bucket.tokens -= 1
	buckets[key] = bucket
	return true
}
