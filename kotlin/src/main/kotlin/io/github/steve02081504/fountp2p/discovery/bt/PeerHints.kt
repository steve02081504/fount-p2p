package io.github.steve02081504.fountp2p.discovery.bt

import io.github.steve02081504.fountp2p.utils.TtlMap

/** BT peer hint 存活时间。 */
const val BT_PEER_HINT_TTL_MS: Long = 5L * 60_000

/** BT periphery hint。 */
data class BtPeerHint(val peripheralId: String)

private val hints = TtlMap<BtPeerHint>(BT_PEER_HINT_TTL_MS)

/**
 * 记录近场 BT 扫描到的 nodeHash → peripheral 映射。
 * @param nodeHash 节点 64 hex
 * @param peripheralId noble peripheral id / address
 */
fun noteBtPeerHint(nodeHash: String?, peripheralId: String?) {
	if (nodeHash.isNullOrEmpty() || peripheralId.isNullOrEmpty()) return
	hints.set(nodeHash, BtPeerHint(peripheralId))
}

/**
 * 查询未过期的 BT peer hint。
 * @param nodeHash 节点 64 hex
 * @param now 当前时间（测试可注入）
 * @return hint 或 null
 */
@JvmOverloads
fun getBtPeerHint(nodeHash: String?, now: Long = System.currentTimeMillis()): BtPeerHint? {
	if (nodeHash.isNullOrEmpty()) return null
	return hints.get(nodeHash, now)
}

/** 清空全部 BT peer hints（测试用）。 */
fun clearBtPeerHints() = hints.clear()
