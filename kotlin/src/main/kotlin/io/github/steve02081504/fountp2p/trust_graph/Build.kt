package io.github.steve02081504.fountp2p.trust_graph

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.JsonUndefined
import io.github.steve02081504.fountp2p.federation.jsNumber
import io.github.steve02081504.fountp2p.node.isPeerKeyBlocked
import io.github.steve02081504.fountp2p.node.isSubjectBlocked
import io.github.steve02081504.fountp2p.node.loadNetwork
import io.github.steve02081504.fountp2p.node.loadReputation
import io.github.steve02081504.fountp2p.registries.listFederationRoomSlots
import io.github.steve02081504.fountp2p.reputation.isQuarantinedPure

/**
 * 从本机 node 状态构建合并信任图（等价 `trust_graph/build.mjs`）。
 *
 * 组合 `node/network` + `node/reputation` + `node/denylist` + `registries/room_provider`，
 * 经 [getCachedTrustGraph] 缓存后交给 engine 合并。
 */

/**
 * @param nodeHash 64 位十六进制
 * @return 是否拉黑
 */
private fun isNodeBlocked(nodeHash: String): Boolean =
	isPeerKeyBlocked("", nodeHash) || isSubjectBlocked(mapOf("nodeHash" to nodeHash))

/** 等价 JS `rep.byNodeHash?.[nodeHash]`（缺失 / undefined 返回 null）。 */
private fun reputationRow(rep: Map<String, Any?>, nodeHash: String): Map<*, *>? =
	Json.obj(rep["byNodeHash"])?.get(nodeHash) as? Map<*, *>

/**
 * @param rep 信誉表
 * @param nodeHash 64 位十六进制
 * @return 本地主观信誉分（等价 JS `Number(rep.byNodeHash?.[nodeHash]?.score ?? 0)`）
 */
private fun networkScoreOf(rep: Map<String, Any?>, nodeHash: String): Double {
	val row = reputationRow(rep, nodeHash)
	// 缺失的 score 在 JS 中是 undefined，经 `?? 0` 归零；JSON null 则走 Number(null)=0。
	val raw = if (row != null && row.containsKey("score")) row["score"] else JsonUndefined
	return if (raw === JsonUndefined) 0.0 else jsNumber(raw)
}

/**
 * @param rep 信誉表
 * @param remoteNodeHash 64 位十六进制
 * @return 本地主观信誉分；从未打分的新人退回 [TrustGraphTunables.rosterDefaultScore]
 */
private fun rosterScoreOf(rep: Map<String, Any?>, remoteNodeHash: String): Double {
	val row = reputationRow(rep, remoteNodeHash) ?: return TrustGraphTunables.rosterDefaultScore
	// 等价 JS `row && Number.isFinite(Number(row.score))`：undefined → NaN → 退回默认分。
	val raw = if (row.containsKey("score")) row["score"] else JsonUndefined
	val score = if (raw === JsonUndefined) Double.NaN else jsNumber(raw)
	return if (score.isFinite()) score else TrustGraphTunables.rosterDefaultScore
}

/**
 * @param username 副本用户名 登录名（联邦房间枚举仍按用户）
 * @return nodeHash → 节点
 */
suspend fun buildMergedGraph(username: String): Map<String, TrustNode> =
	getCachedTrustGraph(username, build = {
		val net = loadNetwork()
		val rep = loadReputation()
		val blocked = LinkedHashSet<String>()
		val quarantined = LinkedHashSet<String>()
		for (nodeHash in net.trustedPeers + net.explorePeers + net.hints.map { it.nodeHash }) {
			if (isNodeBlocked(nodeHash)) blocked.add(nodeHash)
			if (isQuarantinedPure(rep, nodeHash)) quarantined.add(nodeHash)
		}

		val rooms = listFederationRoomSlots(username)
		val roomRosters = ArrayList<RoomRoster>()
		for (room in rooms) {
			val nodeHashes = ArrayList<String>()
			for (peer in room.getRoster()) {
				val remoteNodeHash = peer.remoteNodeHash
				if (remoteNodeHash.isNullOrEmpty()) continue
				if (isNodeBlocked(remoteNodeHash)) blocked.add(remoteNodeHash)
				else if (isQuarantinedPure(rep, remoteNodeHash)) quarantined.add(remoteNodeHash)
				else nodeHashes.add(remoteNodeHash)
			}
			roomRosters.add(
				RoomRoster(
					scopeId = room.groupId,
					nodeHashes = nodeHashes,
					scoreOf = { remoteNodeHash -> rosterScoreOf(rep, remoteNodeHash) },
				),
			)
		}

		mergeGraph(
			TrustGraphInputs(
				trustedPeers = net.trustedPeers.toList(),
				explorePeers = net.explorePeers.toList(),
				hints = net.hints.map { TrustHint(it.nodeHash, it.source, it.weight, it.expiresAt) },
				roomRosters = roomRosters,
				blockedNodeHashes = blocked,
				quarantinedNodeHashes = quarantined,
				scoreOf = { nodeHash -> networkScoreOf(rep, nodeHash) },
			),
		)
	})

/**
 * @param username 副本用户名 登录名
 * @param limit 最多返回节点数
 * @return 按信誉降序
 */
suspend fun pickTopNodes(
	username: String,
	limit: Double = TrustGraphTunables.pickTopNodesDefaultLimit,
): List<TrustNode> {
	val rep = loadReputation()
	val quarantined = LinkedHashSet<String>()
	for (id in Json.obj(rep["byNodeHash"])?.keys ?: emptySet()) {
		if (isQuarantinedPure(rep, id)) quarantined.add(id)
	}
	return pickTopFromGraph(buildMergedGraph(username), limit, TrustGraphTunables.map, quarantined)
}
