package io.github.steve02081504.fountp2p.node

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.JsonUndefined
import io.github.steve02081504.fountp2p.core.isEntityHash128
import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.federation.jsNumber
import io.github.steve02081504.fountp2p.federation.jsString
import io.github.steve02081504.fountp2p.federation.jsTruthy

/**
 * 节点级 P2P 网络表（等价 `node/network.mjs`）。
 *
 * 联邦术语（Wave 6）：
 * - **block**：Social 对外联邦公开拉黑（personal_block / timeline block 事件）
 * - **hide**：纯本地隐藏（personal_hide，不联邦）
 * - **deny**：节点连接拒绝（denylist.json，scope node/subject/entity）
 * - **ban**：群成员治理（member_ban DAG + bannedMembers 物化态）
 */

private const val DATA_NAME = "network"
private const val MAX_EXPLORE = 500
private const val MAX_TRUSTED = 64
private const val MAX_HINTS = 256
private const val MAX_HINTS_PER_SOURCE = 12
private const val DEFAULT_EXPLORE_TTL_MS = 7.0 * 24 * 60 * 60 * 1000

/** 扩边 hint。 */
data class NetworkHint(
	val nodeHash: String,
	val source: String,
	val kind: String,
	val weight: Double,
	val expiresAt: Double,
	val groupId: String? = null,
)

/** 规范化网络表。 */
class NetworkData(
	var trustedPeers: MutableList<String>,
	var explorePeers: MutableList<String>,
	var hints: MutableList<NetworkHint>,
	var lastRosterAt: Double,
)

/** `network.json` 内存缓存（唯一写路径 [saveNetwork] 负责刷新）。 */
private var networkCache: NetworkData? = null

/** 缓存所属 nodeDir（切换节点/未初始化时失效）。 */
private var networkCacheNodeDir: String? = null

/** @return 条目 JSON */
private fun hintToJson(hint: NetworkHint): Map<String, Any?> {
	val out = LinkedHashMap<String, Any?>()
	out["nodeHash"] = hint.nodeHash
	out["source"] = hint.source
	out["kind"] = hint.kind
	out["weight"] = hint.weight
	out["expiresAt"] = hint.expiresAt
	if (hint.groupId != null) out["groupId"] = hint.groupId
	return out
}

/** @return 网络表 JSON（键序同 JS） */
private fun networkToJson(data: NetworkData): Map<String, Any?> = linkedMapOf(
	"trustedPeers" to data.trustedPeers.toList(),
	"explorePeers" to data.explorePeers.toList(),
	"hints" to data.hints.map { hintToJson(it) },
	"lastRosterAt" to data.lastRosterAt,
)

/** 等价 JS `Number(x) || 0`。 */
private fun numberOrZero(value: Any?): Double {
	if (value == null || value === JsonUndefined) return 0.0
	val n = jsNumber(value)
	return if (n.isNaN() || n == 0.0) 0.0 else n
}

/**
 * @param raw 磁盘 JSON
 * @return 规范化网络表
 */
fun normalizeNetwork(raw: Map<String, Any?>?): NetworkData {
	val file = raw ?: emptyMap()

	fun pickIds(key: String): MutableList<String> {
		val out = LinkedHashSet<String>()
		for (value in Json.arr(file[key]) ?: emptyList()) {
			val id = isHex64(value)
			if (id != null) out.add(id)
		}
		return ArrayList(out)
	}

	val hints = ArrayList<NetworkHint>()
	for (item in Json.arr(file["hints"]) ?: emptyList()) {
		val hint = item as? Map<*, *> ?: continue
		val nodeHash = isHex64(hint["nodeHash"]) ?: continue
		val weight = if (hint.containsKey("weight")) {
			val n = jsNumber(hint["weight"])
			if (n.isFinite()) n else 0.1
		}
		else 0.1
		val groupId = if (jsTruthy(hint["groupId"])) jsString(hint["groupId"]) else null
		hints.add(
			NetworkHint(
				nodeHash = nodeHash,
				source = if (jsTruthy(hint["source"])) jsString(hint["source"]) else "",
				kind = if (jsTruthy(hint["kind"])) jsString(hint["kind"]) else "",
				weight = weight,
				expiresAt = numberOrZero(hint["expiresAt"]),
				groupId = groupId,
			),
		)
	}

	val rawLastRosterAt = file["lastRosterAt"]
	val lastRosterAt = if (rawLastRosterAt is Number && rawLastRosterAt.toDouble().isFinite()) rawLastRosterAt.toDouble() else 0.0

	return NetworkData(
		trustedPeers = pickIds("trustedPeers"),
		explorePeers = pickIds("explorePeers"),
		hints = hints,
		lastRosterAt = lastRosterAt,
	)
}

/** @return 节点级 P2P 网络（内存缓存） */
fun loadNetwork(): NetworkData {
	val nodeDir = if (isNodeInitialized()) getNodeDir() else ""
	val cached = networkCache
	if (cached != null && networkCacheNodeDir == nodeDir) return cached
	networkCacheNodeDir = nodeDir
	val loaded = normalizeNetwork(readNodeJsonSync(DATA_NAME) as? Map<String, Any?>)
	networkCache = loaded
	return loaded
}

/**
 * 限制同一 source 的 hint 数量，防止 PEX/单源灌满 explore。
 * @param hints hint 列表
 * @param maxPerSource 每源上限
 * @return 裁剪后列表（保留较新条目）
 */
fun capHintsBySource(hints: List<NetworkHint>, maxPerSource: Int = MAX_HINTS_PER_SOURCE): List<NetworkHint> {
	val counts = HashMap<String, Int>()
	val out = ArrayList<NetworkHint>()
	for (hint in hints.reversed()) {
		val source = hint.source.ifEmpty { "unknown" }
		val n = counts[source] ?: 0
		if (n >= maxPerSource) continue
		counts[source] = n + 1
		out.add(0, hint)
	}
	return out
}

/** @param data 网络表 */
fun saveNetwork(data: NetworkData) {
	val clean = normalizeNetwork(networkToJson(data))
	val now = System.currentTimeMillis().toDouble()
	clean.hints = ArrayList(
		capHintsBySource(clean.hints.filter { it.expiresAt == 0.0 || it.expiresAt > now }).takeLast(MAX_HINTS),
	)
	clean.explorePeers = ArrayList(clean.explorePeers.takeLast(MAX_EXPLORE))
	clean.trustedPeers = ArrayList(clean.trustedPeers.takeLast(MAX_TRUSTED))
	writeNodeJsonSync(DATA_NAME, networkToJson(clean))
	networkCache = clean
	networkCacheNodeDir = if (isNodeInitialized()) getNodeDir() else ""
	bumpLocalDataRevision()
}

/** @param hint 扩边 hint */
fun applyNetworkHint(hint: Map<String, Any?>) {
	val nodeHash = isHex64(hint["nodeHash"]) ?: return
	val net = loadNetwork()
	val now = System.currentTimeMillis().toDouble()
	val ttlMs = if (hint.containsKey("ttlMs") && jsNumber(hint["ttlMs"]).isFinite()) jsNumber(hint["ttlMs"]) else DEFAULT_EXPLORE_TTL_MS
	val expiresAt = if (hint.containsKey("expiresAt") && jsNumber(hint["expiresAt"]).isFinite()) jsNumber(hint["expiresAt"]) else now + ttlMs
	val source = if (jsTruthy(hint["source"])) jsString(hint["source"]) else "unknown"
	val priorSources = net.hints.filter { it.nodeHash == nodeHash }
		.map { it.source.ifEmpty { "unknown" } }
		.toMutableSet()
	priorSources.add(source)
	val multiSourceBoost = if (priorSources.size >= 2) 1.2 else 1.0
	val rawWeight = hint["weight"]
	val baseWeight = if (rawWeight is Number && rawWeight.toDouble().isFinite()) rawWeight.toDouble() else 0.1
	if (!net.explorePeers.contains(nodeHash)) net.explorePeers.add(nodeHash)
	val kind = if (jsTruthy(hint["kind"])) jsString(hint["kind"]) else "hint"
	net.hints = ArrayList(net.hints.filter { it.nodeHash != nodeHash || it.kind != kind })
	net.hints.add(
		NetworkHint(
			nodeHash = nodeHash,
			source = source,
			kind = kind,
			weight = baseWeight * multiSourceBoost,
			expiresAt = expiresAt,
			groupId = if (jsTruthy(hint["groupId"])) jsString(hint["groupId"]) else null,
		),
	)
	saveNetwork(net)
}

/** 疑似分区/eclipse 后：用 trusted 锚点加宽 explore，便于恢复联邦可达。 */
fun widenExploreFromTrustedAnchors() {
	if (!isNodeInitialized()) return
	val net = loadNetwork()
	val now = System.currentTimeMillis().toDouble()
	for (raw in net.trustedPeers.take(12)) {
		val nodeHash = isHex64(raw) ?: continue
		if (!net.explorePeers.contains(nodeHash)) net.explorePeers.add(nodeHash)
		net.hints.add(
			NetworkHint(
				nodeHash = nodeHash,
				source = "recovery:trusted",
				kind = "partition_recovery",
				weight = 0.35,
				expiresAt = now + 6 * 60 * 60 * 1000,
			),
		)
	}
	net.hints = ArrayList(capHintsBySource(net.hints).takeLast(MAX_HINTS))
	net.explorePeers = ArrayList(net.explorePeers.takeLast(MAX_EXPLORE))
	saveNetwork(net)
}

/** @param patch 增量 trusted/explore 池 */
fun mergeNetworkPeerPools(patch: Map<String, Any?>? = null) {
	val net = loadNetwork()
	for (raw in Json.arr(patch?.get("trustedPeers")) ?: emptyList()) {
		val id = isHex64(raw) ?: continue
		if (!net.trustedPeers.contains(id)) net.trustedPeers.add(id)
	}
	for (raw in Json.arr(patch?.get("explorePeers")) ?: emptyList()) {
		val id = isHex64(raw) ?: continue
		if (!net.explorePeers.contains(id)) net.explorePeers.add(id)
	}
	net.lastRosterAt = System.currentTimeMillis().toDouble()
	saveNetwork(net)
}

/** @param nodeHash 对端 nodeHash */
fun promoteExplorePeer(nodeHash: Any?) {
	val net = loadNetwork()
	val id = isHex64(nodeHash) ?: return
	net.explorePeers = ArrayList(net.explorePeers.filter { it != id })
	if (!net.trustedPeers.contains(id)) net.trustedPeers.add(id)
	net.lastRosterAt = System.currentTimeMillis().toDouble()
	saveNetwork(net)
}

/** @param pools 要替换的 peer 池 */
fun replaceNetworkPeerPools(pools: Map<String, Any?>? = null) {
	val net = loadNetwork()
	val trusted = pools?.get("trustedPeers")
	if (trusted is List<*>) net.trustedPeers = ArrayList(trusted.mapNotNull { isHex64(it) })
	val explore = pools?.get("explorePeers")
	if (explore is List<*>) net.explorePeers = ArrayList(explore.mapNotNull { isHex64(it) })
	net.lastRosterAt = System.currentTimeMillis().toDouble()
	saveNetwork(net)
}

/** @return 规范化 value 列表 */
private fun denyValuesForScope(groupId: String, scope: String): List<String> {
	val out = LinkedHashSet<String>()
	val blocked = loadDenylist()["blocked"] as? List<*> ?: emptyList<Any?>()
	for (item in blocked) {
		val entry = item as? Map<*, *> ?: continue
		if (entry["scope"] != scope) continue
		val entryGroup = entry["groupId"]
		val keep = scope == "entity" || !jsTruthy(entryGroup) || groupId.isEmpty() || entryGroup == groupId
		if (!keep) continue
		val value = entry["value"] as? String ?: continue
		out.add(value)
	}
	return out.toList()
}

/** 节点级 network + 群 scope denylist 视图（供 peer_pool 选取）。 */
class PeerPoolView(
	val trustedPeers: List<String> = emptyList(),
	val explorePeers: List<String> = emptyList(),
	val blockedPeers: List<String> = emptyList(),
	val deniedNodes: List<String> = emptyList(),
	val deniedSubjects: List<String> = emptyList(),
	val deniedEntities: List<String> = emptyList(),
	val lastRosterAt: Double = 0.0,
	val hintSources: Map<String, String> = emptyMap(),
)

/**
 * @param groupId 群 scope；空则仅全局 deny
 * @return 连接池视图
 */
fun loadPeerPoolView(groupId: String = ""): PeerPoolView {
	val net = loadNetwork()
	val deniedNodes = denyValuesForScope(groupId, "node")
	val deniedSubjects = denyValuesForScope(groupId, "subject")
	val deniedEntities = denyValuesForScope(groupId, "entity")
	val hintSources = LinkedHashMap<String, String>()
	for (hint in net.hints)
		if (!hintSources.containsKey(hint.nodeHash))
			hintSources[hint.nodeHash] = hint.source

	return PeerPoolView(
		trustedPeers = net.trustedPeers.toList(),
		explorePeers = net.explorePeers.toList(),
		blockedPeers = deniedNodes,
		deniedNodes = deniedNodes,
		deniedSubjects = deniedSubjects,
		deniedEntities = deniedEntities,
		lastRosterAt = net.lastRosterAt,
		hintSources = hintSources,
	)
}

/**
 * @param view 连接池视图
 * @param key nodeHash / pubKeyHash / entityHash 键
 * @return 是否命中 denylist（按 scope 匹配）
 */
fun isPeerPoolKeyBlocked(view: PeerPoolView, key: String?): Boolean {
	if (key.isNullOrEmpty()) return false
	if (view.deniedNodes.contains(key)) return true
	if (view.deniedSubjects.contains(key)) return true
	if (isEntityHash128(key) != null && view.deniedEntities.contains(key)) return true
	return false
}
