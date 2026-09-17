package io.github.steve02081504.fountp2p.trust_graph

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.node.getNodeHash
import io.github.steve02081504.fountp2p.node.loadReputation
import io.github.steve02081504.fountp2p.registries.listFederationRoomSlots
import io.github.steve02081504.fountp2p.reputation.isQuarantinedPure
import io.github.steve02081504.fountp2p.transport.USER_ROOM_SCOPE
import io.github.steve02081504.fountp2p.transport.sendToNodeLink

/**
 * Trust graph 定向发送与 fanout（等价 `js/trust_graph/send.mjs`）。
 *
 * 依赖已移植的 `transport/link_registry`（[sendToNodeLink]）、`registries/room_provider`
 * 与 `node/reputation_store`。
 */

/**
 * @param username 副本用户名 登录名
 * @param targetNodeHash 64 位十六进制
 * @param actionName Trystero 动作
 * @param payload 载荷
 * @param graph 已构建信任图（省略时内部构建）
 * @return 是否已发送
 */
@JvmOverloads
suspend fun sendToNode(
	username: String,
	targetNodeHash: String,
	actionName: String,
	payload: Any?,
	graph: Map<String, TrustNode>? = null,
): Boolean {
	val target = isHex64(targetNodeHash) ?: return false

	// 已直连 peer 不经 trust-graph scope 也应能收发 node scope action（非成员 CAS chunk / follow hint 等）
	if (sendToNodeLink(target, linkedMapOf("scope" to "node", "action" to actionName, "payload" to payload)))
		return true

	val merged = graph ?: buildMergedGraph(username)
	val targetNode = merged[target] ?: return false
	if (targetNode.scopeIds.isEmpty()) return false
	val selfNodeHash = getNodeHash()

	val rooms = listFederationRoomSlots(username)
	val userRooms = rooms.filter { it.groupId == USER_ROOM_SCOPE }
	val groupRooms = rooms.filter { it.groupId != USER_ROOM_SCOPE }

	for (userRoom in userRooms) {
		val peerId = userRoom.getPeerIdByNodeHash(target)
		if (!peerId.isNullOrEmpty()) {
			userRoom.sendToPeer(peerId, actionName, payload)
			return true
		}
	}

	for (room in groupRooms) {
		if (!targetNode.scopeIds.contains(room.groupId)) continue
		val peerId = room.getPeerIdByNodeHash(targetNodeHash)
		if (!peerId.isNullOrEmpty()) {
			room.sendToPeer(peerId, actionName, payload)
			return true
		}
		val pickFallback = room.pickFallbackPeerIds
		if (pickFallback != null) {
			val targets = pickFallback(selfNodeHash)
			if (targets.isNotEmpty()) {
				for (targetPeerId in targets.take(TrustGraphTunables.sendFallbackPeerLimit.toInt()))
					room.sendToPeer(targetPeerId, actionName, payload)
				return true
			}
		}
	}
	return false
}

/**
 * @param username 副本用户名 登录名
 * @param actionName action 名
 * @param payload 载荷
 * @param limit K（省略时按 roster 规模缩放）
 * @return 发送次数
 */
@JvmOverloads
suspend fun fanoutToTopNodes(
	username: String,
	actionName: String,
	payload: Any?,
	limit: Int? = null,
): Int {
	val graph = buildMergedGraph(username)
	val k = limit ?: resolveFederationFanoutTopK(graph.size, TrustGraphTunables.map)
	val rep = loadReputation()
	val quarantined = LinkedHashSet<String>()
	for (id in Json.obj(rep["byNodeHash"])?.keys ?: emptySet())
		if (isQuarantinedPure(rep, id)) quarantined.add(id)
	val topNodes = pickTopFromGraph(graph, k.toDouble(), TrustGraphTunables.map, quarantined)
	var sent = 0
	for (node in topNodes)
		if (sendToNode(username, node.nodeHash, actionName, payload, graph)) sent++
	return sent
}

// 顶层引用：`createDefaultTrustGraphProvider` 的匿名对象成员与顶层函数同名，故在此绑定。
internal val defaultTrustGraphBuild: suspend (String) -> Map<String, TrustNode> = { buildMergedGraph(it) }
internal val defaultTrustGraphPickTop: suspend (String, Int) -> List<TrustNode> =
	{ username, limit -> pickTopNodes(username, limit.toDouble()) }
internal val defaultTrustGraphSend: suspend (String, String, String, Any?, Map<String, TrustNode>?) -> Boolean =
	{ username, target, action, payload, graph -> sendToNode(username, target, action, payload, graph) }
internal val defaultTrustGraphFanout: suspend (String, String, Any?, Int?) -> Int =
	{ username, action, payload, limit -> fanoutToTopNodes(username, action, payload, limit) }
