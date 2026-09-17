package io.github.steve02081504.fountp2p.transport

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.JsonUndefined
import io.github.steve02081504.fountp2p.core.compareHex64Asc
import io.github.steve02081504.fountp2p.federation.jsNumber
import io.github.steve02081504.fountp2p.federation.jsNumberOr
import io.github.steve02081504.fountp2p.federation.jsTruthy
import io.github.steve02081504.fountp2p.node.PeerPoolView
import io.github.steve02081504.fountp2p.node.loadPeerPoolView
import io.github.steve02081504.fountp2p.node.loadReputation
import io.github.steve02081504.fountp2p.node.mergeNetworkPeerPools
import io.github.steve02081504.fountp2p.registries.RosterPeer
import io.github.steve02081504.fountp2p.reputation.clampReputationScore
import io.github.steve02081504.fountp2p.reputation.isQuarantinedPure
import io.github.steve02081504.fountp2p.utils.shuffleInPlace
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * 连接池纯计算（等价 `js/transport/peer_pool.mjs`）：
 * - 群联邦稀疏拨号：trustedSlots + exploreSlots（groupSettings）
 * - 节点 mesh 保活：N / K_max（routing profile + transport tunables）
 * 不含文件 I/O；I/O 由调用方注入（[loadPeerPoolView] / [loadReputation] / [mergeNetworkPeerPools]）。
 */

/** 解析后的联邦池参数。 */
data class FederationPoolLimits(
	val trustedSlots: Int,
	val exploreSlots: Int,
	val maxPeers: Int,
	val gossipTtl: Double,
	val wantIdsBudget: Int,
	val batterySaver: Boolean,
)

/** mesh 槽位上限。 */
data class MeshPoolLimits(val N: Int, val K_max: Int)

/** 重算后的 trusted/explore。 */
data class PeerPoolUpdate(val trustedPeers: List<String>, val explorePeers: List<String>)

/** @return 当前毫秒时间戳（等价 JS `Date.now()`）。 */
private fun currentTimeMs(): Double = System.currentTimeMillis().toDouble()

/**
 * 解析联邦池槽位参数（从 groupSettings 读取，含低功耗缩减）。
 * @param groupSettings 群设置
 * @return 解析后的联邦池参数
 */
fun resolveFederationPoolLimits(groupSettings: Map<String, Any?>? = null): FederationPoolLimits {
	val settings = groupSettings ?: emptyMap()
	val battery = jsTruthy(settings["batterySaver"])
	val trustedSlots = if (battery) 2
	else max(1.0, min(32.0, jsNumberOr(jsNumber(settings["trustedPeerSlots"]), 8.0))).toInt()
	val exploreSlots = if (battery) 1
	else max(0.0, min(16.0, jsNumberOr(jsNumber(settings["explorePeerSlots"]), 4.0))).toInt()
	val maxPeersRaw = jsNumber(settings["maxPeers"])
	val maxPeers = if (maxPeersRaw.isFinite() && maxPeersRaw > 0)
		min(64.0, floor(maxPeersRaw)).toInt()
	else
		min(64.0, max((trustedSlots + exploreSlots).toDouble(), 24.0)).toInt()
	var trustedOut = trustedSlots
	var exploreOut = exploreSlots
	if (trustedOut + exploreOut > maxPeers) {
		trustedOut = min(trustedOut, maxPeers)
		exploreOut = min(exploreOut, max(0, maxPeers - trustedOut))
	}
	val gossipRaw = jsNumber(settings["gossipTtl"])
	val gossipTtl = max(0.0, min(8.0, if (gossipRaw.isFinite()) gossipRaw else 2.0))
	val wantIdsBudget = max(4.0, min(128.0, jsNumberOr(jsNumber(settings["wantIdsBudget"]), 16.0))).toInt()
	return FederationPoolLimits(trustedOut, exploreOut, maxPeers, gossipTtl, wantIdsBudget, battery)
}

/**
 * @param nodeId 节点 id
 * @param rep 信誉表
 * @return 排序分
 */
private fun repScore(nodeId: String, rep: Map<String, Any?>?): Double {
	val row = Json.at(Json.at(rep, "byNodeHash"), nodeId)
	val scoreRaw = Json.at(row, "score")
	val score = if (scoreRaw == null || scoreRaw === JsonUndefined) 0.0 else jsNumber(scoreRaw)
	return clampReputationScore(if (score.isFinite()) score else 0.0)
}

/** explore 选取时单 source 上限 */
const val EXPLORE_MAX_PER_SOURCE: Int = 3

/**
 * trusted 锚点优先保留，再按信誉填充剩余槽位。
 * @param existingTrusted 既有 trusted
 * @param rankedCandidates 信誉排序候选
 * @param limits 槽位
 * @param blockedPeers 拉黑列表
 * @return 新 trusted 列表
 */
fun mergeTrustedWithAnchors(
	existingTrusted: List<String>,
	rankedCandidates: List<String>,
	limits: FederationPoolLimits,
	blockedPeers: List<String> = emptyList(),
): List<String> {
	val blocked = blockedPeers.toSet()
	val candidateSet = rankedCandidates.filter { it.isNotEmpty() && !blocked.contains(it) }.toSet()
	val anchored = existingTrusted.filter { it.isNotEmpty() && !blocked.contains(it) && candidateSet.contains(it) }
	val anchoredSet = anchored.toSet()
	val fill = rankedCandidates.filter { it.isNotEmpty() && !blocked.contains(it) && !anchoredSet.contains(it) }
	return (anchored + fill).take(limits.trustedSlots)
}

/**
 * 按 source 轮询选取 explore，限制单源占比。
 * @param exploreIds 候选 nodeHash
 * @param exploreSources nodeHash → source
 * @param k 选取数量
 * @param maxPerSource 每源上限
 * @return 选取结果
 */
fun selectExploreWithSourceQuota(
	exploreIds: List<String>,
	exploreSources: Map<String, String>?,
	k: Int,
	maxPerSource: Int = EXPLORE_MAX_PER_SOURCE,
): List<String> {
	if (k <= 0 || exploreIds.isEmpty()) return emptyList()
	if (exploreSources.isNullOrEmpty()) return shuffleInPlace(ArrayList(exploreIds)).take(k)
	val bySource = LinkedHashMap<String, MutableList<String>>()
	for (id in exploreIds) {
		val source = exploreSources[id].takeUnless { it.isNullOrEmpty() } ?: "unknown"
		bySource.getOrPut(source) { ArrayList() }.add(id)
	}
	for (ids in bySource.values) shuffleInPlace(ids)
	val out = ArrayList<String>()
	val picked = LinkedHashMap<String, Int>()
	while (out.size < k) {
		var progressed = false
		for ((source, ids) in bySource) {
			if (out.size >= k) break
			val index = picked[source] ?: 0
			if (index >= maxPerSource || index >= ids.size) continue
			out.add(ids[index])
			picked[source] = index + 1
			progressed = true
		}
		if (!progressed) break
	}
	return out
}

/**
 * 稀疏连接池纯选取：按 Top-K trusted + M random explore + 剩余按信誉补至 maxPeers。
 * @param roster 在线表
 * @param peers 池状态
 * @param rep 信誉表
 * @param limits 槽位
 * @param selfNodeHash 本机 node_id
 * @param inRoomNodeHashes 群内在线 node_id；有则优先
 * @param hintSources explore 节点来源（用于配额）
 * @return 目标 peerId 列表（去重，长度 ≤ maxPeers）
 */
fun selectPeerIdsFromPool(
	roster: List<RosterPeer>,
	peers: PeerPoolView,
	rep: Map<String, Any?>?,
	limits: FederationPoolLimits,
	selfNodeHash: String,
	inRoomNodeHashes: Set<String>? = null,
	hintSources: Map<String, String>? = null,
): List<String> {
	val blocked = peers.blockedPeers.toSet()
	val roomSet = inRoomNodeHashes ?: emptySet()
	val onlineAll = roster.filter {
		it.peerId.isNotEmpty() &&
			!it.remoteNodeHash.isNullOrEmpty() &&
			it.remoteNodeHash != selfNodeHash &&
			!blocked.contains(it.remoteNodeHash)
	}
	val onlineInRoom = if (roomSet.isNotEmpty())
		onlineAll.filter { roomSet.contains(it.remoteNodeHash) }
	else onlineAll
	val online = if (onlineInRoom.isNotEmpty()) onlineInRoom else onlineAll
	if (online.isEmpty()) return emptyList()

	val peerIdByNodeHash = LinkedHashMap<String, String>()
	for (entry in online) peerIdByNodeHash[entry.remoteNodeHash!!] = entry.peerId
	val trustedSet = peers.trustedPeers.filter { peerIdByNodeHash.containsKey(it) }.toSet()
	val exploreSet = peers.explorePeers.filter { peerIdByNodeHash.containsKey(it) && !trustedSet.contains(it) }.toSet()

	val outPeerIds = LinkedHashSet<String>()
	fun pushNode(nodeHash: String) {
		val peerId = peerIdByNodeHash[nodeHash]
		if (peerId != null) outPeerIds.add(peerId)
	}

	val anchoredTrusted = peers.trustedPeers.filter { trustedSet.contains(it) }
	val rankedTrusted = trustedSet.sortedWith(compareByDescending { repScore(it, rep) })
	for (nodeId in mergeTrustedWithAnchors(anchoredTrusted, rankedTrusted, limits)) {
		if (outPeerIds.size >= limits.maxPeers) break
		pushNode(nodeId)
	}

	for (nodeId in selectExploreWithSourceQuota(exploreSet.toList(), hintSources, limits.exploreSlots)) {
		if (outPeerIds.size >= limits.maxPeers) break
		pushNode(nodeId)
	}

	val remainingNodeHashes = peerIdByNodeHash.keys
		.filter { !trustedSet.contains(it) && !exploreSet.contains(it) }
		.sortedWith(compareByDescending { repScore(it, rep) })
	for (nodeHash in remainingNodeHashes) {
		if (outPeerIds.size >= limits.maxPeers) break
		pushNode(nodeHash)
	}

	return outPeerIds.toList().take(limits.maxPeers)
}

/**
 * 从群成员集合选出应主动建链的 nodeHash（top-K 信任 + M 随机 explore + 强制锚点必连）。
 * @param members 群成员集合
 * @param selfNodeHash 本机 node_id
 * @param rep 信誉表
 * @param peers 池状态
 * @param limits 槽位
 * @param anchors 强制锚点
 * @return 应建链的 nodeHash 列表（去重）
 */
fun selectLinkTargetsFromMembers(
	members: Iterable<String>,
	selfNodeHash: String,
	rep: Map<String, Any?>?,
	peers: PeerPoolView,
	limits: FederationPoolLimits,
	anchors: Iterable<String> = emptyList(),
): List<String> {
	val blocked = peers.blockedPeers.toSet()
	val current = currentTimeMs()
	val candidates = members.toSet().filter {
		it.isNotEmpty() && it != selfNodeHash && !blocked.contains(it) && !isQuarantinedPure(rep, it, current)
	}
	val ranked = candidates.sortedWith(compareByDescending { repScore(it, rep) })
	val candidateSet = candidates.toSet()
	// 锚点（如 introducer/creator/seed）必连、且不占 trustedSlots——保证引导期连通。
	val forced = anchors.toSet().filter { candidateSet.contains(it) }
	val chosen = LinkedHashSet(forced)
	// trusted 槽只从非锚点候选填：既有 trusted 优先保留，再按信誉补至 trustedSlots。
	val nonForced = ranked.filter { !chosen.contains(it) }
	for (id in mergeTrustedWithAnchors(peers.trustedPeers, nonForced, limits))
		chosen.add(id)
	val remaining = ranked.filter { !chosen.contains(it) }
	for (id in selectExploreWithSourceQuota(remaining, peers.hintSources, limits.exploreSlots))
		chosen.add(id)
	return chosen.toList()
}

/**
 * 将候选 id 并入 explore，并按信誉重填 trusted。
 * @param peers 池状态
 * @param rep 信誉表
 * @param addIds 增量
 * @param limits 槽位
 * @return 重算后的 trusted/explore
 */
private fun rebuildExploreAndTrusted(
	peers: PeerPoolView,
	rep: Map<String, Any?>?,
	addIds: Iterable<String>,
	limits: FederationPoolLimits,
): PeerPoolUpdate {
	val blocked = peers.blockedPeers.toSet()
	val explore = LinkedHashSet(peers.explorePeers)
	for (id in addIds)
		if (id.isNotEmpty() && !blocked.contains(id)) explore.add(id)
	val newExplorePeers = explore.filter { !blocked.contains(it) }.toList().takeLast(500)
	val ranked = LinkedHashSet(peers.trustedPeers + newExplorePeers)
		.filter { !blocked.contains(it) }
		.sortedWith(compareByDescending { repScore(it, rep) })
	return PeerPoolUpdate(
		trustedPeers = mergeTrustedWithAnchors(peers.trustedPeers, ranked, limits, peers.blockedPeers),
		explorePeers = newExplorePeers,
	)
}

/**
 * PEX 线索并入 explore 并重填 trusted（纯计算）。
 * @param peers 池状态
 * @param rep 信誉表
 * @param hints PEX hints
 * @param limits 槽位
 * @return 重算后的 trusted/explore
 */
fun applyPexHints(peers: PeerPoolView, rep: Map<String, Any?>?, hints: List<String>, limits: FederationPoolLimits): PeerPoolUpdate =
	rebuildExploreAndTrusted(peers, rep, hints, limits)

/**
 * roster 观测并入 explore 并重填 trusted（纯计算）。
 * @param peers 池状态
 * @param rep 信誉表
 * @param roster roster
 * @param limits 槽位
 * @return 重算后的 trusted/explore
 */
fun applyRosterToPeerPool(peers: PeerPoolView, rep: Map<String, Any?>?, roster: List<RosterPeer>, limits: FederationPoolLimits): PeerPoolUpdate =
	rebuildExploreAndTrusted(peers, rep, roster.mapNotNull { it.remoteNodeHash }.filter { it.isNotEmpty() }, limits)

/**
 * 稀疏连接池：优先 trusted，再 explore，再其余在线节点。
 * @param groupId 群
 * @param roster 在线表
 * @param groupSettings 物化群设置
 * @param selfNodeHash 本机 node_id
 * @return 目标 peerId（去重）
 */
fun pickFederationTargetPeerIds(
	groupId: String,
	roster: List<RosterPeer>,
	groupSettings: Map<String, Any?>?,
	selfNodeHash: String,
): List<String> {
	val limits = resolveFederationPoolLimits(groupSettings)
	val peers = loadPeerPoolView(groupId)
	val rep = loadReputation()
	return selectPeerIdsFromPool(
		roster = roster,
		peers = peers,
		rep = rep,
		limits = limits,
		selfNodeHash = selfNodeHash,
		inRoomNodeHashes = roster.mapNotNull { it.remoteNodeHash }.filter { it.isNotEmpty() }.toSet(),
		hintSources = peers.hintSources,
	)
}

/**
 * 合并 PEX 提示并提升长期高信誉节点为 trusted。
 * @param groupId 群
 * @param hints 节点 id 列表
 * @param groupSettings 群设置
 */
fun mergePexNodeHints(groupId: String, hints: List<String>, groupSettings: Map<String, Any?>?) {
	val limits = resolveFederationPoolLimits(groupSettings)
	val peers = loadPeerPoolView(groupId)
	val rep = loadReputation()
	val update = applyPexHints(peers, rep, hints, limits)
	mergeNetworkPeerPools(linkedMapOf("trustedPeers" to update.trustedPeers, "explorePeers" to update.explorePeers))
}

/**
 * roster 观测：将在线节点并入 explore，并按信誉填充 trusted 槽位。
 * @param groupId 群
 * @param roster 在线表
 * @param groupSettings 群设置
 */
fun reconcilePeerPoolFromRoster(groupId: String, roster: List<RosterPeer>, groupSettings: Map<String, Any?>?) {
	if (roster.isEmpty()) return
	val limits = resolveFederationPoolLimits(groupSettings)
	val peers = loadPeerPoolView(groupId)
	val rep = loadReputation()
	val update = applyRosterToPeerPool(peers, rep, roster, limits)
	mergeNetworkPeerPools(linkedMapOf("trustedPeers" to update.trustedPeers, "explorePeers" to update.explorePeers))
}

/**
 * Mesh 保活 N/K 槽位（routing profile 可缩 N 与 K_max）。
 * @param routingProfile 路由 profile
 * @param tunables transport tunables
 * @return mesh 槽位上限 N 与熟人槽 K_max
 */
fun resolveMeshPoolLimits(routingProfile: String = "default", tunables: Map<String, Any?> = emptyMap()): MeshPoolLimits {
	val low = routingProfile == "low"
	val nRaw = if (low) tunables["meshNLow"] else tunables["meshN"]
	val n = max(1.0, min(32.0, jsNumberOr(jsNumber(nRaw), if (low) 4.0 else 8.0)))
	val kRaw = if (low) tunables["meshKMaxLow"] else tunables["meshKMax"]
	val kMax = max(0.0, min(n, jsNumberOr(jsNumber(kRaw), if (low) 2.0 else 5.0)))
	return MeshPoolLimits(n.toInt(), kMax.toInt())
}

/**
 * 选取 mesh 拨号目标：补齐 K 熟人（可超出当前空位，由调用方先踢探索），再按 N−K 探索配额填空。
 * @param selfNodeHash 本机 node_id
 * @param trustedPeers 熟人池
 * @param exploreCandidates 探索候选
 * @param hintSources explore 来源
 * @param limits mesh 槽位
 * @param connectedHashes 已连接 nodeHash
 * @param rep 信誉表
 * @param blockedPeers 拉黑列表
 * @param now 当前时间
 * @return 应拨号的 nodeHash（熟人可导致需先驱逐探索）
 */
fun selectMeshLinkTargets(
	selfNodeHash: String,
	trustedPeers: List<String> = emptyList(),
	exploreCandidates: List<String> = emptyList(),
	hintSources: Map<String, String>? = null,
	limits: MeshPoolLimits,
	connectedHashes: Set<String>,
	rep: Map<String, Any?>?,
	blockedPeers: List<String> = emptyList(),
	now: Double = currentTimeMs(),
): List<String> {
	val blocked = blockedPeers.toSet()
	val connected = connectedHashes

	val eligibleTrusted = trustedPeers.toSet()
		.filter { it.isNotEmpty() && it != selfNodeHash && !blocked.contains(it) }
		.filter { !isQuarantinedPure(rep, it, now) }
	val trustedSet = eligibleTrusted.toSet()
	/** 目标组成：K 熟人槽 + (N−K) 探索槽 */
	val k = min(limits.K_max, eligibleTrusted.size)
	var connectedTrusted = 0
	var connectedExplore = 0
	for (id in connected)
		if (trustedSet.contains(id)) connectedTrusted++ else connectedExplore++
	val trustedSlotsLeft = max(0, k - connectedTrusted)
	val trustedRanked = eligibleTrusted
		.filter { !connected.contains(it) }
		.sortedWith(compareByDescending { repScore(it, rep) })
	// 熟人缺口优先补齐，即使当前已满 N（调用方应先踢探索腾位）
	val trustedPick = trustedRanked.take(trustedSlotsLeft)

	val exploreQuota = max(0, limits.N - k)
	val exploreSlotsLeft = max(0, exploreQuota - connectedExplore)
	val freeAfterTrustedDial = max(0, limits.N - connected.size - trustedPick.size)
	val exploreNeed = min(exploreSlotsLeft, freeAfterTrustedDial)
	val explorePool = exploreCandidates.toSet()
		.filter { it.isNotEmpty() && it != selfNodeHash && !blocked.contains(it) && !connected.contains(it) && !trustedSet.contains(it) }
		.filter { !isQuarantinedPure(rep, it, now) }
	val explorePick = selectExploreWithSourceQuota(explorePool, hintSources, exploreNeed)
	return trustedPick + explorePick
}

/**
 * mesh trim：探索链优先驱逐，同档取 scope 权重低、nodeHash 小。
 * @param linkHashes 当前链路 nodeHash
 * @param exploreLinkHashes 探索链集合
 * @param trustedPeers 熟人池
 * @param scopeWeightFn scope 权重
 * @return 应驱逐的 nodeHash
 */
fun pickMeshEvictionVictim(
	linkHashes: List<String>,
	exploreLinkHashes: Set<String>,
	trustedPeers: List<String>,
	scopeWeightFn: (nodeHash: String) -> Double,
): String? {
	val trustedSet = trustedPeers.toSet()
	var victimHash: String? = null
	var victimScore = Double.POSITIVE_INFINITY
	for (nodeHash in linkHashes) {
		val isExplore = exploreLinkHashes.contains(nodeHash) && !trustedSet.contains(nodeHash)
		val weight = scopeWeightFn(nodeHash)
		val score = (if (isExplore) 0.0 else 1000.0) + weight
		val currentVictim = victimHash
		if (
			currentVictim == null ||
			score < victimScore ||
			(score == victimScore && compareHex64Asc(nodeHash, currentVictim) < 0)
		) {
			victimHash = nodeHash
			victimScore = score
		}
	}
	return victimHash
}
