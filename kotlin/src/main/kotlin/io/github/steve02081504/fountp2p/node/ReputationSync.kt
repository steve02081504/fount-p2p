package io.github.steve02081504.fountp2p.node

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.JsonUndefined
import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.federation.jsNumber
import io.github.steve02081504.fountp2p.federation.jsString
import io.github.steve02081504.fountp2p.federation.jsTruthy
import io.github.steve02081504.fountp2p.transport.node_scope.attachNodeScopeFeature
import io.github.steve02081504.fountp2p.transport.node_scope.ensureNodeScope
import io.github.steve02081504.fountp2p.transport.node_scope.getNodeScopeWire
import io.github.steve02081504.fountp2p.transport.sendToNodeLink
import io.github.steve02081504.fountp2p.wire.WireHandler
import io.github.steve02081504.fountp2p.wire.subscribeWire
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * 信誉同步 wire / donor 拉取（等价 `js/node/reputation_sync.mjs`）。
 *
 * 依赖已移植的 `transport/node_scope`（feature 挂载）与 `transport/link_registry`（[sendToNodeLink]）。
 */

private const val SYNC_DATA_NAME = "reputation_sync"
private const val MAX_LOCKED_SCORE = 1.0

/** 内存 sync 配置。 */
private class ReputationSyncConfig(
	var trustSyncDonors: List<String>,
	var reputationExportAllowlist: List<String>,
	var lockedMaxNodeHashes: MutableList<String>,
	val lockedMaxPrevByNodeHash: MutableMap<String, Double>,
) {
	/** @return 与 JS 键序一致的 JSON 对象 */
	fun toJson(): Map<String, Any?> = linkedMapOf(
		"trustSyncDonors" to trustSyncDonors,
		"reputationExportAllowlist" to reputationExportAllowlist,
		"lockedMaxNodeHashes" to lockedMaxNodeHashes.toList(),
		"lockedMaxPrevByNodeHash" to LinkedHashMap(lockedMaxPrevByNodeHash),
	)
}

/** 在飞的 donor 拉取。 */
private class PendingPull(
	val deferred: CompletableDeferred<Any?>,
	val timer: Job,
	val donor: String,
)

private var syncConfig: ReputationSyncConfig? = null

private val pendingPulls = LinkedHashMap<String, PendingPull>()

private val syncWireDisposers = LinkedHashSet<() -> Unit>()

private val repSyncScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

private var pullTimeoutMs = 8000L

/**
 * @param ms 超时毫秒；测试用
 */
fun setReputationPullTimeoutMsForTests(ms: Any?) {
	val n = jsNumber(ms)
	pullTimeoutMs = maxOf(1.0, if (!n.isFinite() || n == 0.0) 8000.0 else n).toLong()
}

/** @param value 成员值 @return 非 null 的 JSON 对象视图 */
private fun jsonObject(value: Any?): Map<String, Any?>? {
	if (value !is Map<*, *>) return null
	val out = LinkedHashMap<String, Any?>()
	for ((key, item) in value) if (key is String) out[key] = item
	return out
}

/**
 * @param list 原始 hash 列表
 * @return 规范化去重后的 64-hex 列表
 */
private fun normalizeHashList(list: Any?): List<String> {
	val arr = list as? List<*> ?: return emptyList()
	val out = LinkedHashSet<String>()
	for (item in arr) {
		val id = isHex64(item)
		if (id != null) out.add(id)
	}
	return out.toList()
}

/** @return 内存中的 sync 配置（首次从盘加载） */
private fun loadSyncConfig(): ReputationSyncConfig {
	syncConfig?.let { return it }
	val raw = jsonObject(readNodeJsonSync(SYNC_DATA_NAME)) ?: emptyMap()
	val lockedMaxPrevByNodeHash = LinkedHashMap<String, Double>()
	val prevRaw = jsonObject(raw["lockedMaxPrevByNodeHash"]) ?: emptyMap()
	for ((nodeHash, score) in prevRaw) {
		val n = jsNumber(score)
		if (isHex64(nodeHash) != null && n.isFinite()) lockedMaxPrevByNodeHash[nodeHash] = n
	}
	val config = ReputationSyncConfig(
		trustSyncDonors = normalizeHashList(raw["trustSyncDonors"]),
		reputationExportAllowlist = normalizeHashList(raw["reputationExportAllowlist"]),
		lockedMaxNodeHashes = normalizeHashList(raw["lockedMaxNodeHashes"]).toMutableList(),
		lockedMaxPrevByNodeHash = lockedMaxPrevByNodeHash,
	)
	syncConfig = config
	return config
}

/** 将当前 sync 配置写盘 */
private fun persistSyncConfig() {
	writeNodeJsonSync(SYNC_DATA_NAME, loadSyncConfig().toJson())
}

/** @param data 信誉存储对象 @return 可变的 byNodeHash */
private fun byNodeHashOf(data: MutableMap<String, Any?>): MutableMap<String, Any?> {
	val existing = data["byNodeHash"]
	if (existing is MutableMap<*, *>) {
		@Suppress("UNCHECKED_CAST")
		return existing as MutableMap<String, Any?>
	}
	val fresh = LinkedHashMap<String, Any?>()
	if (existing is Map<*, *>) for ((key, value) in existing) if (key is String) fresh[key] = value
	data["byNodeHash"] = fresh
	return fresh
}

/**
 * @param table 含 byNodeHash 的信誉表或裸 byNodeHash 对象
 */
suspend fun setReputationTable(table: Any?) {
	val byNodeProp = Json.at(table, "byNodeHash")
	@Suppress("UNCHECKED_CAST")
	val incoming: Map<*, *>? = (byNodeProp as? Map<*, *>) ?: (table as? Map<*, *>)
	if (incoming == null) throw IllegalArgumentException("p2p: setReputationTable requires byNodeHash object")
	mutateReputation { data ->
		val byNode = byNodeHashOf(data)
		for ((nodeKey, row) in incoming) {
			val id = isHex64(nodeKey) ?: continue
			val rawScore = (row as? Map<*, *>)?.get("score") ?: row
			val score = jsNumber(rawScore)
			if (!score.isFinite()) continue
			val merged = LinkedHashMap<String, Any?>()
			val existing = byNode[id]
			if (existing is Map<*, *>) for ((k, v) in existing) if (k is String) merged[k] = v
			merged["score"] = score
			byNode[id] = merged
		}
		applyLocksToReputation(data)
	}
}

/**
 * @param data 信誉存储对象
 */
private fun applyLocksToReputation(data: MutableMap<String, Any?>) {
	val byNode = byNodeHashOf(data)
	for (nodeHash in loadSyncConfig().lockedMaxNodeHashes) {
		val existing = byNode[nodeHash]
		if (existing is MutableMap<*, *>) {
			@Suppress("UNCHECKED_CAST")
			(existing as MutableMap<String, Any?>)["score"] = MAX_LOCKED_SCORE
		}
		else byNode[nodeHash] = linkedMapOf("score" to MAX_LOCKED_SCORE)
	}
}

/**
 * 将节点分数钳到上限；首次 lock 时记下原分，unlock 时还原。
 * @param nodeHashes 要 lock 的节点 hash 列表
 */
suspend fun lockReputationMax(nodeHashes: Any?) {
	val config = loadSyncConfig()
	val hashes = normalizeHashList(nodeHashes)
	mutateReputation { data ->
		val byNode = byNodeHashOf(data)
		for (hash in hashes) {
			if (config.lockedMaxNodeHashes.contains(hash)) continue
			val prev = jsNumber(Json.at(byNode[hash], "score"))
			config.lockedMaxPrevByNodeHash[hash] = if (prev.isFinite()) prev else 0.0
			config.lockedMaxNodeHashes.add(hash)
		}
		persistSyncConfig()
		applyLocksToReputation(data)
	}
}

/**
 * 解除上限钳；还原 lock 前记下的分数。
 * @param nodeHashes 要 unlock 的节点 hash 列表
 */
suspend fun unlockReputationMax(nodeHashes: Any?) {
	val config = loadSyncConfig()
	val remove = normalizeHashList(nodeHashes).toSet()
	if (remove.isEmpty()) return
	config.lockedMaxNodeHashes = config.lockedMaxNodeHashes.filter { !remove.contains(it) }.toMutableList()
	val restore = LinkedHashMap<String, Double>()
	for (hash in remove)
		if (config.lockedMaxPrevByNodeHash.containsKey(hash)) {
			restore[hash] = config.lockedMaxPrevByNodeHash[hash]!!
			config.lockedMaxPrevByNodeHash.remove(hash)
		}

	persistSyncConfig()
	mutateReputation { data ->
		val byNode = byNodeHashOf(data)
		for ((hash, score) in restore) {
			val existing = byNode[hash]
			if (existing is MutableMap<*, *>) {
				@Suppress("UNCHECKED_CAST")
				(existing as MutableMap<String, Any?>)["score"] = score
			}
			else byNode[hash] = linkedMapOf("score" to score)
		}
	}
}

/** @return 当前锁定为满分的节点 hash 列表 */
fun getReputationLocks(): List<String> = loadSyncConfig().lockedMaxNodeHashes.toList()

/** @param donors 允许拉取信誉的 donor 节点 */
fun setTrustSyncDonors(donors: Any?) {
	loadSyncConfig().trustSyncDonors = normalizeHashList(donors)
	persistSyncConfig()
}

/** @return 当前 trustSyncDonors 副本 */
fun getTrustSyncDonors(): List<String> = loadSyncConfig().trustSyncDonors.toList()

/** @param allowlist 允许导出本机信誉表的节点 */
fun setReputationExportAllowlist(allowlist: Any?) {
	loadSyncConfig().reputationExportAllowlist = normalizeHashList(allowlist)
	persistSyncConfig()
}

/** @return 当前 reputationExportAllowlist 副本 */
fun getReputationExportAllowlist(): List<String> = loadSyncConfig().reputationExportAllowlist.toList()

/** @return 仅含 score 的导出表 */
private fun exportScoreTable(): Map<String, Any?> {
	val rep = loadReputation()
	val out = LinkedHashMap<String, Any?>()
	for ((nodeHash, row) in Json.obj(rep["byNodeHash"]) ?: emptyMap<String, Any?>()) {
		val raw = (row as? Map<*, *>)?.get("score") ?: 0.0
		out[nodeHash] = linkedMapOf("score" to jsNumber(raw))
	}
	return linkedMapOf("byNodeHash" to out)
}

/**
 * 挂载信誉同步 wire（refcount；处理 rep_sync_req / rep_sync_res）。
 * @return 取消 wire 挂载的 dispose
 */
fun attachReputationSyncWire(): () -> Unit {
	ensureNodeScope()
	if (getNodeScopeWire() == null) throw IllegalStateException("p2p: attachReputationSyncWire requires node scope wire")
	val dispose = attachNodeScopeFeature(
		"rep_sync",
		{ wire, _ ->
			subscribeWire(
				wire,
				linkedMapOf<String, WireHandler>(
					"rep_sync_req" to { payload, peerId ->
						val requester = peerId
						if (requester.isNotEmpty() && getReputationExportAllowlist().contains(requester)) {
							try {
								val response = LinkedHashMap<String, Any?>()
								response["requestId"] = Json.at(payload, "requestId")
								response.putAll(exportScoreTable())
								wire.send("rep_sync_res", response, peerId)
							}
							catch (_: Throwable) {
								// disconnected
							}
						}
					},
					"rep_sync_res" to { payload, peerId ->
						val rawRequestId = Json.at(payload, "requestId")
						val requestId = if (jsTruthy(rawRequestId)) jsString(rawRequestId) else ""
						val pending = pendingPulls[requestId]
						if (pending != null && peerId == pending.donor) {
							pending.timer.cancel()
							pendingPulls.remove(requestId)
							pending.deferred.complete(payload)
						}
					},
				),
			)
		},
	)
	syncWireDisposers.add(dispose)
	return {
		if (syncWireDisposers.remove(dispose)) dispose()
	}
}

/** 卸掉信誉同步 wire（强制清掉全部 ref）。 */
fun detachReputationSyncWire() {
	for (dispose in syncWireDisposers.toList()) {
		syncWireDisposers.remove(dispose)
		try {
			dispose()
		}
		catch (_: Throwable) {
			// ignore
		}
	}
}

/**
 * 从 donor 拉取信誉表 JSON；不落盘。应用需自行 [setReputationTable]。
 * @param nodeHash donor 节点 64-hex hash
 * @return donor 返回的信誉表
 */
suspend fun pullReputationFromNode(nodeHash: Any?): Any? {
	val donor = isHex64(nodeHash)
		?: throw IllegalArgumentException("p2p: pullReputationFromNode requires valid nodeHash")
	if (!getTrustSyncDonors().contains(donor))
		throw IllegalStateException("p2p: node not in trustSyncDonors")
	attachReputationSyncWire()
	val requestId = UUID.randomUUID().toString()
	val deferred = CompletableDeferred<Any?>()
	val timer = repSyncScope.launch {
		delay(pullTimeoutMs)
		pendingPulls.remove(requestId)
		deferred.completeExceptionally(IllegalStateException("p2p: rep_sync timeout"))
	}
	pendingPulls[requestId] = PendingPull(deferred, timer, donor)
	val ok = sendToNodeLink(
		donor,
		linkedMapOf(
			"scope" to "node",
			"action" to "rep_sync_req",
			"payload" to linkedMapOf<String, Any?>("requestId" to requestId),
		),
	)
	if (!ok) {
		val pending = pendingPulls[requestId]
		if (pending != null) {
			pending.timer.cancel()
			pendingPulls.remove(requestId)
		}
		throw IllegalStateException("p2p: rep_sync_req send failed")
	}
	return deferred.await()
}

/** 重置 sync 运行时（测试用） */
fun resetReputationSyncForTests() {
	syncConfig = null
	detachReputationSyncWire()
	for (pending in pendingPulls.values) pending.timer.cancel()
	pendingPulls.clear()
	pullTimeoutMs = 8000L
}
