/**
 * 令牌桶限速：桶容量 burst，补充速率 perMin/分钟。
 * @param {Map<string, { tokens: number, updatedAt: number }>} buckets 每键桶状态
 * @param {string} key 桶键（如发送方 nodeHash）
 * @param {number} now 当前时间戳（ms）
 * @param {{ perMin: number, burst: number }} limits 限速参数
 * @returns {boolean} 是否允许本次消费
 */
export function consumeToken(buckets, key, now, limits) {
	const perMin = Math.max(1, limits.perMin)
	const burst = Math.max(1, limits.burst)
	const refillPerMs = perMin / 60_000
	let bucket = buckets.get(key)
	if (!bucket) bucket = { tokens: burst, updatedAt: now }
	const elapsed = Math.max(0, now - bucket.updatedAt)
	bucket.tokens = Math.min(burst, bucket.tokens + elapsed * refillPerMs)
	bucket.updatedAt = now
	if (bucket.tokens < 1) {
		buckets.set(key, bucket)
		return false
	}
	bucket.tokens -= 1
	buckets.set(key, bucket)
	return true
}
