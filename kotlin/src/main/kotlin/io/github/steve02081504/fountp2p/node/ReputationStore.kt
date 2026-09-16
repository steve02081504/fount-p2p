package io.github.steve02081504.fountp2p.node

import io.github.steve02081504.fountp2p.core.JsonUndefined
import io.github.steve02081504.fountp2p.core.assertHex64
import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.federation.jsNumber
import io.github.steve02081504.fountp2p.federation.jsString
import io.github.steve02081504.fountp2p.federation.jsTruthy
import io.github.steve02081504.fountp2p.federation.recordWantIdsBackoff
import io.github.steve02081504.fountp2p.federation.wantIdsPeerKey
import io.github.steve02081504.fountp2p.reputation.applyDecayCollusionAfterSlashPure
import io.github.steve02081504.fountp2p.reputation.applyReputationResetToScoresPure
import io.github.steve02081504.fountp2p.reputation.applySubjectiveSlashPure
import io.github.steve02081504.fountp2p.reputation.bumpChunkStorageReputationPure
import io.github.steve02081504.fountp2p.reputation.bumpReputationOnRelayPure
import io.github.steve02081504.fountp2p.reputation.DEFAULT_REPUTATION_TUNABLES
import io.github.steve02081504.fountp2p.reputation.defaultReputationTunables
import io.github.steve02081504.fountp2p.reputation.ensureReputationShape
import io.github.steve02081504.fountp2p.reputation.observeBehaviorSamplePure
import io.github.steve02081504.fountp2p.reputation.penalizeArchiveServeMismatchPure
import io.github.steve02081504.fountp2p.reputation.penalizeChunkStorageFailurePure
import io.github.steve02081504.fountp2p.reputation.pickNodeScoreFromReputation
import io.github.steve02081504.fountp2p.reputation.pruneReputationFile
import io.github.steve02081504.fountp2p.reputation.recordGossipAllUnknownWantPure
import io.github.steve02081504.fountp2p.reputation.recordMessageRateViolationPure
import io.github.steve02081504.fountp2p.reputation.resolveSlashAlertTtlMsPure
import io.github.steve02081504.fountp2p.reputation.seedMemberReputationFromIntroducerPure
import io.github.steve02081504.fountp2p.utils.withAsyncMutex

/**
 * 节点级信誉表读写（等价 `node/reputation_store.mjs`）。
 *
 * 说明：JS 中 `bumpChunkStorageReputation` / `penalizeChunkStorageFailure` /
 * `penalizeArchiveServeMismatch` / `applyDecayCollusionAfterSlash` 等以 fire-and-forget
 * 方式触发（返回 void 不 await）；Kotlin 侧改为 `suspend` 以遵循结构化并发（行为等价，
 * 调用方可自行决定是否等待）。
 */

private const val DATA_NAME = "reputation"

private var blockReputationHandler: (suspend (Map<String, Any?>) -> Boolean)? = null

/** @param handler block/unblock 信誉传导回调 */
fun registerBlockReputationHandler(handler: (suspend (Map<String, Any?>) -> Boolean)?) {
	blockReputationHandler = handler
}

/** 取消注册 block/unblock 信誉传导回调。 */
fun unregisterBlockReputationHandler() {
	blockReputationHandler = null
}

private var reputationCache: MutableMap<String, Any?>? = null
private var reputationCacheNodeDir: String? = null

/** @param key tunable 键 @return 数值 */
private fun tunable(key: String): Double = DEFAULT_REPUTATION_TUNABLES[key] as Double

/** @return 节点级信誉表 */
fun loadReputation(): MutableMap<String, Any?> {
	val nodeDir = if (isNodeInitialized()) getNodeDir() else ""
	val cached = reputationCache
	if (cached != null && reputationCacheNodeDir == nodeDir) return cached
	reputationCacheNodeDir = nodeDir
	val raw = readNodeJsonSync(DATA_NAME)
	val data: MutableMap<String, Any?> = if (raw is MutableMap<*, *>) {
		@Suppress("UNCHECKED_CAST")
		raw as MutableMap<String, Any?>
	}
	else LinkedHashMap()
	reputationCache = ensureReputationShape(data)
	return reputationCache!!
}

/** @param data 信誉表 */
fun saveReputation(data: MutableMap<String, Any?>) {
	pruneReputationFile(data)
	writeNodeJsonSync(DATA_NAME, data)
	reputationCache = data
	bumpLocalDataRevision()
}

/** @param mutator 突变 */
suspend fun mutateReputation(mutator: suspend (MutableMap<String, Any?>) -> Unit) {
	withAsyncMutex("reputation") {
		val data = loadReputation()
		mutator(data)
		saveReputation(data)
	}
}

/** @param peerNodeHash 对端节点 @param dedupeKey 去重键 */
suspend fun bumpReputationOnRelay(peerNodeHash: String?, dedupeKey: String? = null) {
	mutateReputation { data ->
		bumpReputationOnRelayPure(data, peerNodeHash, dedupeKey)
	}
}

/** @param groupId 群 ID（仅用于 want 去重键） @param peerNodeHash 请求方 */
suspend fun recordGossipAllUnknownWant(groupId: String, peerNodeHash: String) {
	mutateReputation { data ->
		if (recordGossipAllUnknownWantPure(data, peerNodeHash))
			recordWantIdsBackoff(wantIdsPeerKey(groupId, peerNodeHash))
	}
}

/** @param peerNodeHash 对端 @param excessRatio 超速超额比例 0..1 */
suspend fun recordMessageRateViolation(peerNodeHash: String?, excessRatio: Double = 1.0) {
	val id = peerNodeHash
	if (id.isNullOrEmpty()) return
	mutateReputation { data ->
		recordMessageRateViolationPure(data, id, defaultReputationTunables(), excessRatio)
		observeBehaviorSamplePure(data, id, 1.0)
	}
}

/**
 * @param peerNodeHash 对端
 * @param sample 行为样本强度
 * @return 是否触发异常隔离
 */
suspend fun observePeerBehavior(peerNodeHash: String?, sample: Double): Boolean {
	val id = peerNodeHash
	if (id.isNullOrEmpty()) return false
	var anomaly = false
	mutateReputation { data ->
		val result = observeBehaviorSamplePure(data, id, sample)
		anomaly = result.anomaly
	}
	return anomaly
}

/** @param storagePeerKey 责任方 */
suspend fun bumpChunkStorageReputation(storagePeerKey: String?) {
	val id = storagePeerKey
	if (id.isNullOrEmpty()) return
	mutateReputation { data -> bumpChunkStorageReputationPure(data, id) }
}

/** @param blamePeerKey 责任方 */
suspend fun penalizeChunkStorageFailure(blamePeerKey: String?) {
	val id = blamePeerKey
	if (id.isNullOrEmpty()) return
	mutateReputation { data -> penalizeChunkStorageFailurePure(data, id) }
}

/** @param peerNodeHash 对端 nodeHash */
suspend fun penalizeArchiveServeMismatch(peerNodeHash: String?) {
	val id = peerNodeHash
	if (id.isNullOrEmpty()) return
	mutateReputation { data -> penalizeArchiveServeMismatchPure(data, id) }
}

/**
 * @param alert VOLATILE slash 载荷
 * @return 是否已应用
 */
suspend fun applyVolatileSlashAlert(alert: Map<String, Any?>?): Boolean {
	val expiresAt = jsNumber(alert?.get("expiresAt"))
	if (expiresAt.isFinite() && System.currentTimeMillis().toDouble() > expiresAt) return false
	val target = isHex64(alert?.get("targetPubKeyHash")) ?: return false
	val sender = isHex64(alert?.get("sender")) ?: return false
	val claim = if (alert != null && alert.containsKey("claim") && jsNumber(alert["claim"]).isFinite())
		jsNumber(alert["claim"])
	else tunable("slashDefaultClaim")
	mutateReputation { data ->
		applySubjectiveSlashPure(data, target, sender, claim, false)
	}
	return true
}

/**
 * @param senderPubKeyHash 签发者
 * @param content Slash 内容
 * @param groupSettings 群设置
 * @return VOLATILE 载荷
 */
fun buildUnverifiedSlashAlert(
	senderPubKeyHash: Any?,
	content: Map<String, Any?>,
	groupSettings: Map<String, Any?>? = null,
): Map<String, Any?> {
	val targetPubKeyHash = assertHex64(content["targetPubKeyHash"], "slash target")
	val claim = if (content.containsKey("claim") && jsNumber(content["claim"]).isFinite())
		jsNumber(content["claim"])
	else tunable("slashDefaultClaim")
	val sender = assertHex64(senderPubKeyHash, "slash sender")
	val ttl = resolveSlashAlertTtlMsPure(groupSettings)
	return linkedMapOf(
		"type" to "reputation_slash_alert",
		"targetPubKeyHash" to targetPubKeyHash,
		"sender" to sender,
		"claim" to claim,
		"expiresAt" to (System.currentTimeMillis().toDouble() + ttl),
	)
}

/**
 * @param username 用户（readEvents 回调用）
 * @param groupId 群
 * @param event reputation_slash 事件
 * @param readEvents 读 DAG 事件
 */
suspend fun applySubjectiveSlashFromEvent(
	username: String,
	groupId: String,
	event: Map<String, Any?>,
	readEvents: suspend (String, String) -> List<Any?>,
) {
	if (event["type"] != "reputation_slash") return
	val content = event["content"] as? Map<*, *> ?: emptyMap<Any?, Any?>()
	@Suppress("UNCHECKED_CAST")
	val contentMap = content as Map<String, Any?>
	val target = contentMap["targetPubKeyHash"]
	val sender = event["sender"]

	mutateReputation { data ->
		val verified = jsTruthy(contentMap["verified"]) && verifySlashProof(username, groupId, contentMap, readEvents)
		val rawClaim = contentMap["claim"]
		val claimValue: Any? = if (rawClaim == null || rawClaim === JsonUndefined)
			tunable(if (verified) "slashVerifiedDefaultClaim" else "slashUnverifiedDefaultClaim")
		else rawClaim
		applySubjectiveSlashPure(data, jsString(target), jsString(sender), jsNumber(claimValue), verified)
	}
}

/**
 * @param username 用户
 * @param groupId 群
 * @param content slash 内容
 * @param readEvents 读 DAG
 * @return 是否找到 proof 对应事件
 */
private suspend fun verifySlashProof(
	username: String,
	groupId: String,
	content: Map<String, Any?>,
	readEvents: suspend (String, String) -> List<Any?>,
): Boolean {
	val eventId = (content["proof"] as? Map<*, *>)?.get("eventId") ?: return false
	val events = readEvents(username, groupId)
	return events.any { (it as? Map<*, *>)?.get("id") == eventId }
}

/**
 * @param targetPubKeyHash 目标
 * @param inviteEdges 邀请边
 */
suspend fun applyDecayCollusionAfterSlash(targetPubKeyHash: String, inviteEdges: List<Any?>?) {
	mutateReputation { data ->
		val applied = applyDecayCollusionAfterSlashPure(data, targetPubKeyHash, inviteEdges)
		if (applied.isNotEmpty())
			getNodeLogger()?.warn(
				"reputation: collusion decay after slash",
				linkedMapOf(
					"target" to targetPubKeyHash,
					"upstreamCount" to applied.size,
					"hops" to applied.map { it.hop },
				),
			)
	}
}

/** @param targetPubKeyHash 目标 */
suspend fun applyReputationResetToScores(targetPubKeyHash: String) {
	mutateReputation { data -> applyReputationResetToScoresPure(data, targetPubKeyHash) }
}

/**
 * @param memberPubKeyHash 新成员
 * @param introducerPubKeyHash 介绍者
 * @param repEdge 边信任
 * @param powBonus 入群 PoW 自愿封顶加成
 */
suspend fun seedMemberReputationFromIntroducer(
	memberPubKeyHash: String,
	introducerPubKeyHash: String?,
	repEdge: Double?,
	powBonus: Double = 0.0,
) {
	mutateReputation { data ->
		seedMemberReputationFromIntroducerPure(data, memberPubKeyHash, introducerPubKeyHash, repEdge, defaultReputationTunables(), powBonus)
	}
}

/** @param nodeId 64 位十六进制 @return 信誉分 */
fun pickNodeScore(nodeId: String): Double = pickNodeScoreFromReputation(loadReputation(), nodeId)

/** @param options applyFollowedBlockSignal 参数 @return 是否已应用 */
suspend fun applyBlockReputationSignal(options: Map<String, Any?>): Boolean {
	val handler = blockReputationHandler ?: return false
	return handler(options)
}
