package io.github.steve02081504.fountp2p.mailbox

import io.github.steve02081504.fountp2p.federation.jsNumber

/**
 * Mailbox 重要性分层与评分（纯函数）。
 *
 * 等价 `js/mailbox/importance.mjs`。
 */

/** tier → 淘汰优先级（低 tier 先淘汰）。 */
private val TIER_ORDER = mapOf("quarantine" to 0, "normal" to 1, "trusted" to 2)

/**
 * 等价 JS `tier || 'normal'` 后查表 `?? 1`：仅当值恰为已知字符串 tier 时取表值。
 * @param row mailbox 记录
 * @return tier 优先级
 */
private fun tierOrder(row: Map<String, Any?>): Int {
	val tier = row["tier"]
	if (tier is String) TIER_ORDER[tier]?.let { return it }
	return 1
}

/**
 * @param row mailbox 记录
 * @return 等价 JS `(row.storedAt || 0)`
 */
private fun storedAtOrZero(row: Map<String, Any?>): Double {
	val value = jsNumber(row["storedAt"])
	return if (value.isNaN() || value == 0.0) 0.0 else value
}

/**
 * 按 tier 与 storedAt 排序（低 tier 先淘汰）。
 * @param rows 记录
 * @return 排序后（稳定排序）
 */
fun sortMailboxForRetention(rows: List<Map<String, Any?>>): List<Map<String, Any?>> =
	rows.sortedWith { a, b ->
		val ta = tierOrder(a)
		val tb = tierOrder(b)
		if (ta != tb) ta - tb
		else {
			val diff = storedAtOrZero(a) - storedAtOrZero(b)
			when {
				diff < 0 -> -1
				diff > 0 -> 1
				else -> 0
			}
		}
	}

/**
 * @param tier 分层
 * @return 默认 TTL 毫秒
 */
fun defaultTtlMsForTier(tier: Any?): Double = when (tier) {
	"trusted" -> 30.0 * 24 * 3600 * 1000
	"normal" -> 7.0 * 24 * 3600 * 1000
	else -> 24.0 * 3600 * 1000
}

/**
 * @param tier 分层
 * @return 是否允许继续转发
 */
fun allowMailboxRelayForTier(tier: Any?): Boolean = tier != "quarantine"
