/**
 * Mailbox 重要性分层与评分（纯函数）。
 */

/** @typedef {'trusted' | 'normal' | 'quarantine'} MailboxTier */

const TIER_ORDER = { quarantine: 0, normal: 1, trusted: 2 }

/**
 * 按 tier 与 storedAt 排序（低 tier 先淘汰）。
 * @param {object[]} rows 记录
 * @returns {object[]} 排序后
 */
export function sortMailboxForRetention(rows) {
	return [...rows].sort((a, b) => {
		const ta = TIER_ORDER[a.tier || 'normal'] ?? 1
		const tb = TIER_ORDER[b.tier || 'normal'] ?? 1
		if (ta !== tb) return ta - tb
		return (a.storedAt || 0) - (b.storedAt || 0)
	})
}

/**
 * @param {MailboxTier} tier 分层
 * @returns {number} 默认 TTL 毫秒
 */
export function defaultTtlMsForTier(tier) {
	if (tier === 'trusted') return 30 * 24 * 3600 * 1000
	if (tier === 'normal') return 7 * 24 * 3600 * 1000
	return 24 * 3600 * 1000
}

/**
 * @param {MailboxTier} tier 分层
 * @returns {boolean} 是否允许继续转发
 */
export function allowMailboxRelayForTier(tier) {
	return tier !== 'quarantine'
}
