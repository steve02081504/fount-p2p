package io.github.steve02081504.fountp2p.transport

import io.github.steve02081504.fountp2p.registries.RosterPeer

/**
 * peer↔node roster 映射工具（等价 `js/transport/peer_identity_maps.mjs`）。
 */

/** roster 按在线性分组结果。 */
data class RosterPartition(val live: List<RosterPeer>, val stale: List<RosterPeer>)

/**
 * 按在线 peer 集合将 roster 分为 live 与 stale。
 * @param rosterEntries roster 条目
 * @param livePeerIds 当前在线 peer id 集合
 * @return 分组结果
 */
fun partitionRosterByLiveness(rosterEntries: List<RosterPeer>, livePeerIds: Iterable<String>): RosterPartition {
	val liveSet = if (livePeerIds is Set<String>) livePeerIds else livePeerIds.toSet()
	val live = ArrayList<RosterPeer>()
	val stale = ArrayList<RosterPeer>()
	for (entry in rosterEntries) {
		if (entry.peerId.isEmpty()) continue
		if (liveSet.contains(entry.peerId)) live.add(entry) else stale.add(entry)
	}
	return RosterPartition(live, stale)
}

/**
 * 从 peer↔node 映射中移除离线条目。
 * @param peerToNode 对端 id → nodeHash
 * @param nodeToPeer nodeHash → 对端 id
 * @param livePeerIds 当前在线 peer id 集合
 * @return 被移除的 stale 条目
 */
fun pruneStaleRosterEntries(
	peerToNode: MutableMap<String, String>,
	nodeToPeer: MutableMap<String, String>,
	livePeerIds: Iterable<String>,
): List<RosterPeer> {
	val entries = peerToNode.entries.map { RosterPeer(it.key, it.value) }
	val stale = partitionRosterByLiveness(entries, livePeerIds).stale
	for (entry in stale) {
		peerToNode.remove(entry.peerId)
		val remoteNodeHash = entry.remoteNodeHash
		if (!remoteNodeHash.isNullOrEmpty() && nodeToPeer[remoteNodeHash] == entry.peerId)
			nodeToPeer.remove(remoteNodeHash)
	}
	return stale
}
