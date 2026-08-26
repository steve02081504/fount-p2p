import { createTtlMap } from '../../utils/ttl_map.mjs'

/** BT peer hint 存活时间。 */
export const BT_PEER_HINT_TTL_MS = 5 * 60_000

/** @type {ReturnType<typeof createTtlMap<{ peripheralId: string }>>} */
const hints = createTtlMap(BT_PEER_HINT_TTL_MS)

/**
 * 记录近场 BT 扫描到的 nodeHash → peripheral 映射。
 * @param {string} nodeHash 节点 64 hex
 * @param {string} peripheralId noble peripheral id / address
 * @returns {void}
 */
export function noteBtPeerHint(nodeHash, peripheralId) {
	if (!nodeHash || !peripheralId) return
	hints.set(nodeHash, { peripheralId })
}

/**
 * 查询未过期的 BT peer hint。
 * @param {string} nodeHash 节点 64 hex
 * @param {number} [now=Date.now()] 当前时间（测试可注入）
 * @returns {{ peripheralId: string } | null} hint 或 null
 */
export function getBtPeerHint(nodeHash, now = Date.now()) {
	if (!nodeHash) return null
	return hints.get(nodeHash, now)
}

/**
 * 清空全部 BT peer hints（测试用）。
 * @returns {void}
 */
export function clearBtPeerHints() {
	hints.clear()
}
