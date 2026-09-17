package io.github.steve02081504.fountp2p.files

import io.github.steve02081504.fountp2p.core.FEDERATION_CHUNK_FETCH_FANOUT_K
import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.node.loadNetwork
import io.github.steve02081504.fountp2p.trust_graph.DEFAULT_TRUST_GRAPH_OWNER
import io.github.steve02081504.fountp2p.trust_graph.requireTrustGraphProvider

/**
 * 联邦 miss 扇出（等价 `files/fetch_fanout.mjs` 的非传输子集）。
 *
 * **移植说明（偏差）**：JS 原文还依赖尚未移植的 `transport/link_registry.mjs`
 * （`listLinks` / `ensureLinkToNode`），用于「先向已直连 peer 定向投递、未直连者后台拨号补发」。
 * Kotlin 侧 `listLinks()` 视为空（无已建立链路）、拨号不可用，故公开模式下直接向
 * `loadNetwork()` 的已知 peer 投递（不主动拨号），再执行 `fanoutToTopNodes`。
 * 定向模式与 node-scope top-K 扇出完整移植。
 */

/**
 * 规范化目标节点集：过滤非 64hex、去重（保持插入序）。fanout 与 manifest in-flight key 共用。
 * @param targets 目标节点集
 * @return 规范化后的目标节点集
 */
fun canonicalizeFanoutTargets(targets: List<*>?): List<String> {
	if (targets == null) return emptyList()
	val out = LinkedHashSet<String>()
	for (target in targets) {
		val valid = isHex64(target)
		if (valid != null) out.add(valid)
	}
	return out.toList()
}

/**
 * @return 全局 miss 时应尝试投递的 nodeHash 列表
 */
private fun fetchPeerTargets(): List<String> {
	val targets = LinkedHashSet<String>()
	// listLinks(): transport/link_registry 未移植 → 视为无已建立链路。
	val net = loadNetwork()
	for (nodeHash in net.trustedPeers) if (nodeHash.isNotEmpty()) targets.add(nodeHash)
	for (nodeHash in net.explorePeers) if (nodeHash.isNotEmpty()) targets.add(nodeHash)
	for (hint in net.hints) if (hint.nodeHash.isNotEmpty()) targets.add(hint.nodeHash)
	return targets.toList()
}

/**
 * 全局 miss 请求扇出：先向已知 peer 定向发送，再 trust-graph top-K fanout。
 * @param username 用户
 * @param action wire action 名
 * @param payload 请求载荷
 * @param fanoutTargets 显式目标节点集（非 public manifest 的授权边界）；提供时（含空/全非法集）只发目标集，不走 node-scope
 */
suspend fun fanoutFedFetch(
	username: String,
	action: String,
	payload: Any?,
	fanoutTargets: List<*>? = null,
) {
	val trustGraph = requireTrustGraphProvider(DEFAULT_TRUST_GRAPH_OWNER)
	if (fanoutTargets != null) {
		// 定向：只发显式目标集（非 public manifest 的授权边界）。
		// 空/全非法集也视为定向——调用方显式提供目标集即声明授权边界，不发 node-scope。
		// 依赖已有链路/群房间投递，不主动拨号——目标本就是已授权成员，无通道即不应服务。
		val graph = trustGraph.buildMergedGraph(username)
		for (nodeHash in canonicalizeFanoutTargets(fanoutTargets))
			trustGraph.sendToNode(username, nodeHash, action, payload, graph)
		return
	}

	val graph = trustGraph.buildMergedGraph(username)
	for (nodeHash in fetchPeerTargets())
		trustGraph.sendToNode(username, nodeHash, action, payload, graph)
	trustGraph.fanoutToTopNodes(username, action, payload, FEDERATION_CHUNK_FETCH_FANOUT_K.toInt())
}
