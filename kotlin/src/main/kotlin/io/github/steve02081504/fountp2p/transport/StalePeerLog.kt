package io.github.steve02081504.fountp2p.transport

import io.github.steve02081504.fountp2p.registries.RosterPeer

/**
 * 联邦/房间陈旧 peer 自愈修剪可观测性：进程内计数器 + 近期记录。
 *
 * 无回退行为——仅在发生处记录异常「身份映射滞后于活跃连接」
 * （群/房间 + peerId + nodeHash），以便追踪 onPeerLeave 遗漏。
 *
 * 等价 `js/transport/stale_peer_log.mjs`。
 */

/** scopeId → 累计修剪次数 */
private val pruneCounts = LinkedHashMap<String, Double>()

/** 近期修剪记录（`{ ts, scope, peerId, nodeHash, ...meta }`） */
private val recent = ArrayList<Map<String, Any?>>()
private const val RECENT_CAP = 200

/**
 * 记录一批陈旧 peer 修剪。
 * @param scope 计数器 scope（群 id / 房间标签）
 * @param staleEntries 被修剪条目
 * @param meta 写入记录的额外上下文（partitionId / room）
 */
fun recordStalePeerPrune(scope: String, staleEntries: List<RosterPeer>, meta: Map<String, Any?> = emptyMap()) {
	if (staleEntries.isEmpty()) return
	pruneCounts[scope] = (pruneCounts[scope] ?: 0.0) + staleEntries.size
	val ts = System.currentTimeMillis().toDouble()
	for (entry in staleEntries) {
		val record = LinkedHashMap<String, Any?>()
		record["ts"] = ts
		record["scope"] = scope
		record["peerId"] = entry.peerId
		record["nodeHash"] = entry.remoteNodeHash?.takeIf { it.isNotEmpty() }
		record.putAll(meta)
		recent.add(record)
	}
	while (recent.size > RECENT_CAP) recent.removeAt(0)
}

/**
 * @param scope 计数器 scope
 * @return 该 scope 累计修剪次数
 */
fun getStalePeerPruneCount(scope: String): Double = pruneCounts[scope] ?: 0.0

/** @return 近期修剪记录 */
fun getRecentStalePeerPrunes(): List<Map<String, Any?>> = ArrayList(recent)
