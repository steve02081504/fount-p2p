package io.github.steve02081504.fountp2p.trust_graph

import io.github.steve02081504.fountp2p.core.Json
import kotlin.math.exp

/**
 * TrustGraph 纯图合并/选择（模拟器与 trust_graph.mjs 共用）。
 *
 * 等价 `trust_graph/engine.mjs`。
 */

/** `trust_graph/tunables.json`。 */
object TrustGraphTunables {
	const val federationFanoutTopKFloor: Double = 3.0
	const val federationFanoutTopKRatio: Double = 0.35
	const val federationFanoutTopKCap: Double = 16.0
	const val federationChunkFetchFanoutK: Double = 6.0
	const val federationChunkMaxBytes: Double = 524288.0
	const val hintDefaultWeight: Double = 0.1
	const val hintMaxBonus: Double = 0.15
	const val rosterDefaultScore: Double = 0.1
	const val sendFallbackPeerLimit: Double = 4.0
	const val pickTopNodesDefaultLimit: Double = 12.0
	const val quarantineTrustDamp: Double = 0.35

	/** 与 `tunables.json` 等价的 JSON 对象视图（保持键序）。 */
	val map: Map<String, Any?> = linkedMapOf(
		"federationFanoutTopKFloor" to federationFanoutTopKFloor,
		"federationFanoutTopKRatio" to federationFanoutTopKRatio,
		"federationFanoutTopKCap" to federationFanoutTopKCap,
		"federationChunkFetchFanoutK" to federationChunkFetchFanoutK,
		"federationChunkMaxBytes" to federationChunkMaxBytes,
		"hintDefaultWeight" to hintDefaultWeight,
		"hintMaxBonus" to hintMaxBonus,
		"rosterDefaultScore" to rosterDefaultScore,
		"sendFallbackPeerLimit" to sendFallbackPeerLimit,
		"pickTopNodesDefaultLimit" to pickTopNodesDefaultLimit,
		"quarantineTrustDamp" to quarantineTrustDamp,
	)
}

/** 信任图节点（等价 JS `TrustNode`）。 */
data class TrustNode(
	val nodeHash: String,
	val score: Double,
	val scopeIds: List<String>,
)

/**
 * @param nodeHash 64 位十六进制
 * @param source 来源标签（缺省 `unknown`）
 * @param weight 权重（缺省 tunables.hintDefaultWeight）
 * @param expiresAt 过期时间（毫秒）
 */
class TrustHint(
	val nodeHash: String,
	val source: String? = null,
	val weight: Double? = null,
	val expiresAt: Double? = null,
)

/**
 * @param scopeId 名册 scope
 * @param nodeHashes 名册内节点
 * @param scoreOf 本地主观信誉查询（返回 null 视作未打分）
 */
class RoomRoster(
	val scopeId: String,
	val nodeHashes: List<String>,
	val scoreOf: ((String) -> Double?)? = null,
)

/**
 * @param trustedPeers 受信 peer nodeHash
 * @param explorePeers 探索 peer nodeHash
 * @param hints 提示
 * @param roomRosters 房间名册
 * @param blockedNodeHashes 本地拉黑集合
 * @param quarantinedNodeHashes 本地隔离集合
 * @param now 当前时间（缺省 now）
 * @param scoreOf 本地主观信誉查询
 */
class TrustGraphInputs(
	val trustedPeers: List<String> = emptyList(),
	val explorePeers: List<String> = emptyList(),
	val hints: List<TrustHint> = emptyList(),
	val roomRosters: List<RoomRoster> = emptyList(),
	val blockedNodeHashes: Set<String> = emptySet(),
	val quarantinedNodeHashes: Set<String> = emptySet(),
	val now: Double? = null,
	val scoreOf: ((String) -> Double?)? = null,
)

/** JS `NodeEvidence`：单个节点收集到的证据。 */
private class NodeEvidence {
	val scopeIds = LinkedHashSet<String>()
	val networkScores = ArrayList<Double>()
	val rosterScores = ArrayList<Double>()
	var hintWeightSum = 0.0
	val hintSources = LinkedHashSet<String>()
}

/**
 * @param evidenceByNode 证据表
 * @param nodeHash 64 位十六进制
 * @return 节点证据容器（不存在则创建）
 */
private fun nodeEvidence(
	evidenceByNode: LinkedHashMap<String, NodeEvidence>,
	nodeHash: String,
): NodeEvidence = evidenceByNode.getOrPut(nodeHash) { NodeEvidence() }

/**
 * @param inputs 图输入
 * @param tunables tunables
 * @return nodeHash → 节点（按证据首次出现顺序）
 */
fun mergeGraph(
	inputs: TrustGraphInputs,
	tunables: Map<String, Any?> = TrustGraphTunables.map,
): LinkedHashMap<String, TrustNode> {
	val evidenceByNode = LinkedHashMap<String, NodeEvidence>()
	val blocked = inputs.blockedNodeHashes
	val quarantined = inputs.quarantinedNodeHashes
	val damp = Json.num(tunables["quarantineTrustDamp"]) ?: 0.35
	val now = inputs.now ?: System.currentTimeMillis().toDouble()
	val hintDefaultWeight = Json.num(tunables["hintDefaultWeight"]) ?: 0.1
	val hintMaxBonus = Json.num(tunables["hintMaxBonus"]) ?: 0.15
	val rosterDefaultScore = Json.num(tunables["rosterDefaultScore"]) ?: 0.1

	for (nodeHash in inputs.trustedPeers + inputs.explorePeers) {
		if (blocked.contains(nodeHash)) continue
		val score = inputs.scoreOf?.invoke(nodeHash) ?: 0.0
		val ev = nodeEvidence(evidenceByNode, nodeHash)
		ev.scopeIds.add("network")
		ev.networkScores.add(score)
	}

	for (hint in inputs.hints) {
		val expiresAt = hint.expiresAt
		if (expiresAt != null && expiresAt.isFinite() && expiresAt != 0.0 && expiresAt <= now) continue
		if (blocked.contains(hint.nodeHash)) continue
		val ev = nodeEvidence(evidenceByNode, hint.nodeHash)
		val source = hint.source ?: "unknown"
		ev.scopeIds.add("hint:$source")
		val rawWeight = hint.weight ?: hintDefaultWeight
		if (rawWeight.isFinite() && rawWeight > 0) ev.hintWeightSum += rawWeight
		ev.hintSources.add(source)
	}

	for (room in inputs.roomRosters) {
		for (remoteNodeHash in room.nodeHashes) {
			if (remoteNodeHash.isEmpty() || blocked.contains(remoteNodeHash)) continue
			// 名册只能告诉你「这个节点存在于该 scope」；信任分一律取本地主观信誉，
			// 仅当本地从未给它打过分（新人）时才退回 rosterDefaultScore。
			val local = room.scoreOf?.invoke(remoteNodeHash) ?: inputs.scoreOf?.invoke(remoteNodeHash)
			val score = if (local != null && local.isFinite()) local else rosterDefaultScore
			val ev = nodeEvidence(evidenceByNode, remoteNodeHash)
			ev.scopeIds.add(room.scopeId)
			ev.rosterScores.add(score)
		}
	}

	val byNode = LinkedHashMap<String, TrustNode>()
	for ((nodeHash, ev) in evidenceByNode) {
		val networkMean = if (ev.networkScores.isNotEmpty())
			ev.networkScores.sum() / ev.networkScores.size else Double.NaN
		val rosterMean = if (ev.rosterScores.isNotEmpty())
			ev.rosterScores.sum() / ev.rosterScores.size else Double.NaN
		val baseScores = listOf(networkMean, rosterMean).filter { it.isFinite() }
		val baseScore = if (baseScores.isNotEmpty()) baseScores.sum() / baseScores.size else 0.0

		// Hint 只做“发现增益”：收益按总权重指数饱和，防止多源投毒线性抬分。
		val hintScale = 0.1
		val saturatedHintLift = hintMaxBonus * (1 - exp(-ev.hintWeightSum / hintScale))
		val hasHardEvidence = ev.networkScores.size + ev.rosterScores.size > 0
		val hintReliability = if (hasHardEvidence) 1.0 else 0.35
		var score = baseScore + saturatedHintLift * hintReliability
		if (quarantined.contains(nodeHash)) score *= damp

		byNode[nodeHash] = TrustNode(nodeHash, score, ev.scopeIds.toList())
	}
	return byNode
}

/**
 * @param graph 合并图
 * @param limit 最多返回节点数
 * @param tunables tunables
 * @param quarantinedNodeHashes 本地隔离节点（踢出 topK）
 * @return 按信誉降序
 */
fun pickTopFromGraph(
	graph: Map<String, TrustNode>,
	limit: Double? = TrustGraphTunables.pickTopNodesDefaultLimit,
	tunables: Map<String, Any?> = TrustGraphTunables.map,
	quarantinedNodeHashes: Set<String> = emptySet(),
): List<TrustNode> {
	val k = limit ?: (Json.num(tunables["pickTopNodesDefaultLimit"]) ?: TrustGraphTunables.pickTopNodesDefaultLimit)
	return graph.values
		.filter { !quarantinedNodeHashes.contains(it.nodeHash) }
		.sortedByDescending { it.score }
		.take(maxOf(1, k.toInt()))
}

/**
 * @param inputs 图输入
 * @param limit fanout K（缺省按 roster 规模缩放）
 * @param tunables tunables
 * @return Top-K 节点
 */
fun pickTop(
	inputs: TrustGraphInputs,
	limit: Double? = null,
	tunables: Map<String, Any?> = TrustGraphTunables.map,
): List<TrustNode> {
	val graph = mergeGraph(inputs, tunables)
	val k = limit ?: resolveFederationFanoutTopK(graph.size, tunables).toDouble()
	return pickTopFromGraph(graph, k, tunables, inputs.quarantinedNodeHashes)
}
