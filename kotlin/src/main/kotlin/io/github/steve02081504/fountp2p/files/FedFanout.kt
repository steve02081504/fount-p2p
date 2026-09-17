package io.github.steve02081504.fountp2p.files

import io.github.steve02081504.fountp2p.core.FEDERATION_CHUNK_FETCH_FANOUT_K
import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.node.loadNetwork
import io.github.steve02081504.fountp2p.transport.ensureLinkToNode
import io.github.steve02081504.fountp2p.transport.listLinks
import io.github.steve02081504.fountp2p.trust_graph.DEFAULT_TRUST_GRAPH_OWNER
import io.github.steve02081504.fountp2p.trust_graph.requireTrustGraphProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.launch

/**
 * 全量 miss 优先扇出（等价 `js/files/fetch_fanout.mjs`）。
 *
 * 已知 peer 立即投递（不等待拨号），未直连 peer 后台拨号后重试；同时并行 node-scope top-K fanout。
 * 全程不阻塞上游窗口。
 */

/** 后台拨号/投递的作用域（不阻塞 fanoutFedFetch 返回，等价 JS 的 `void`）。 */
private val fedFanoutScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

/**
 * @return 全量 miss 时应尝试投递/拨号的 nodeHash 列表
 */
private fun fetchPeerTargets(): List<String> {
	val targets = LinkedHashSet<String>()
	for (ref in listLinks()) if (ref.nodeHash.isNotEmpty()) targets.add(ref.nodeHash)
	val net = loadNetwork()
	for (nodeHash in net.trustedPeers) if (nodeHash.isNotEmpty()) targets.add(nodeHash)
	for (nodeHash in net.explorePeers) if (nodeHash.isNotEmpty()) targets.add(nodeHash)
	for (hint in net.hints) if (hint.nodeHash.isNotEmpty()) targets.add(hint.nodeHash)
	return targets.toList()
}

/**
 * 规范化目标节点集（过滤非 64hex、去重，保持插入序）。fanout 与 manifest in-flight key 复用。
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
 * 全量 miss 后优先尝试所有已知 peer 扇出，兜底 trust-graph top-K fanout。
 * @param username 用户
 * @param action wire action 名
 * @param payload 请求载荷
 * @param fanoutTargets 显式目标节点集（public manifest 调用者边界）；提供时不再做全量/全栈 fanout
 */
suspend fun fanoutFedFetch(
	username: String,
	action: String,
	payload: Any?,
	fanoutTargets: List<*>? = null,
) {
	val trustGraph = requireTrustGraphProvider(DEFAULT_TRUST_GRAPH_OWNER)
	if (fanoutTargets != null) {
		// 只有显式目标集（public manifest 调用者边界）才走这里；
		// 不做全栈 fanout——调用方显式提供目标集即定义边界，不用 node-scope。
		val graph = trustGraph.buildMergedGraph(username)
		for (nodeHash in canonicalizeFanoutTargets(fanoutTargets))
			trustGraph.sendToNode(username, nodeHash, action, payload, graph)
		return
	}

	val graph = trustGraph.buildMergedGraph(username)
	val peerTargets = fetchPeerTargets()
	// 已直连 peer 立即投递，不等拨号；其余 peer 后台拨号，先就群组房/overlay 尝试投递，同时拨号，若投递失败再重试。
	val linked = listLinks().mapTo(HashSet()) { it.nodeHash }
	for (nodeHash in peerTargets) {
		if (linked.contains(nodeHash)) {
			fedFanoutScope.launch { trustGraph.sendToNode(username, nodeHash, action, payload, graph) }
			continue
		}
		val dialed = fedFanoutScope.async {
			try {
				ensureLinkToNode(nodeHash)
			}
			catch (_: Throwable) {
				null
			}
		}
		fedFanoutScope.launch {
			val sent = trustGraph.sendToNode(username, nodeHash, action, payload, graph)
			if (sent) return@launch
			val link = dialed.await()
			if (link != null) trustGraph.sendToNode(username, nodeHash, action, payload, graph)
		}
	}
	trustGraph.fanoutToTopNodes(username, action, payload, FEDERATION_CHUNK_FETCH_FANOUT_K.toInt())
}
