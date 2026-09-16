package io.github.steve02081504.fountp2p.reputation

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.JsonUndefined

/**
 * 信誉纯内存算子（模拟器与磁盘 store 共用）。
 *
 * 信誉表 [data] 与其中的行沿用 JS 的 JSON 对象模型：`MutableMap<String, Any?>`
 * （构造时为 [LinkedHashMap] 以保持键序），行内可选字段用 `remove` 删除以复刻
 * JS `delete` 语义。
 */

/** 观测结果：`{ z, anomaly }`。 */
data class BehaviorSample(val z: Double, val anomaly: Boolean)

/** 已应用的上游惩罚：`{ hop, node, dRep }`。 */
data class AppliedDecay(val hop: Int, val node: String, val dRep: Double)

/** @param v 任意值 @return 是否为 List（否则空列表） */
private fun asList(v: Any?): List<Any?> = v as? List<Any?> ?: emptyList()

/**
 * 等价 JS `Number(x ?? 0)`：缺失/null/undefined 记 0。
 * @param v 任意值
 * @return 数值
 */
private fun numberOrZero(v: Any?): Double = if (v == null || v === JsonUndefined) 0.0 else jsNumberValue(v)

/** @return 行的 `score`（缺失为 0）。 */
private fun scoreOf(data: Map<String, Any?>, nodeId: String): Double =
	numberOrZero(Json.at(Json.at(Json.at(data, "byNodeHash"), nodeId), "score"))

/**
 * @param data 信誉表
 * @param nodeId 64 位十六进制
 * @return 节点行（拷贝，含可选字段）
 */
private fun repRow(data: Map<String, Any?>, nodeId: String): LinkedHashMap<String, Any?> {
	val rowAny = Json.at(Json.at(data, "byNodeHash"), nodeId)
	val row: Map<String, Any?> = Json.obj(rowAny) ?: mapOf("score" to 0.0)
	val out = LinkedHashMap<String, Any?>()
	out["score"] = numberOrZero(row["score"])
	val offenseStreak = row["offenseStreak"]
	if (jsNumberValue(offenseStreak).isFinite()) out["offenseStreak"] = offenseStreak
	val lastOffenseAt = row["lastOffenseAt"]
	if (jsNumberValue(lastOffenseAt).isFinite()) out["lastOffenseAt"] = lastOffenseAt
	if (jsTruthy(row["blockPenalties"])) out["blockPenalties"] = row["blockPenalties"]
	if (jsTruthy(row["baseline"])) out["baseline"] = row["baseline"]
	val quarantinedUntil = row["quarantinedUntil"]
	if (jsNumberValue(quarantinedUntil).isFinite()) out["quarantinedUntil"] = quarantinedUntil
	return out
}

/**
 * @param data 信誉表
 * @param nodeId 64 位十六进制
 * @return 节点行（可变引用）
 */
private fun ensureRow(data: MutableMap<String, Any?>, nodeId: String): MutableMap<String, Any?> {
	val byNodeHash = ensureByNodeHash(data)
	val existing = byNodeHash[nodeId]
	if (existing is MutableMap<*, *>) {
		@Suppress("UNCHECKED_CAST")
		return existing as MutableMap<String, Any?>
	}
	val row = LinkedHashMap<String, Any?>()
	row["score"] = 0.0
	byNodeHash[nodeId] = row
	return row
}

/** @return `data.byNodeHash`（缺失时补建）。 */
private fun ensureByNodeHash(data: MutableMap<String, Any?>): MutableMap<String, Any?> {
	val existing = data["byNodeHash"]
	if (existing is MutableMap<*, *>) {
		@Suppress("UNCHECKED_CAST")
		return existing as MutableMap<String, Any?>
	}
	val created = LinkedHashMap<String, Any?>()
	data["byNodeHash"] = created
	return created
}

/**
 * @param streak 连续作恶次数
 * @param tunables 参数
 * @return 惩罚乘子 ≥ 1
 */
fun computeRecidivismMultiplier(streak: Double, tunables: Map<String, Any?> = defaultReputationTunables()): Double {
	val step = tunableNumber(tunables, "recidivismMultiplierStep", 0.0)
	val maxMult = tunableNumber(tunables, "recidivismMax", 1.0)
	if (!streak.isFinite() || streak <= 0 || step <= 0 || maxMult <= 1) return 1.0
	return minOf(maxMult, 1.0 + step * streak)
}

/**
 * @param badCount 坏邀请计数
 * @param tunables 参数
 * @return 惩罚乘子 ≥ 1
 */
fun computeInviteEscalation(badCount: Double, tunables: Map<String, Any?> = defaultReputationTunables()): Double {
	val step = tunableNumber(tunables, "inviteBadEscalationStep", 0.0)
	val maxMult = tunableNumber(tunables, "inviteBadEscalationMax", 1.0)
	if (!badCount.isFinite() || badCount <= 0 || step <= 0 || maxMult <= 1) return 1.0
	return minOf(maxMult, 1.0 + step * badCount)
}

/**
 * @param row byNodeHash 行
 * @param gain 正向收益
 * @param tunables 参数
 */
private fun applyRedemptionFromGain(row: MutableMap<String, Any?>, gain: Double, tunables: Map<String, Any?>) {
	if (!gain.isFinite() || gain <= 0) return
	val perStreak = tunableNumber(tunables, "redemptionCreditPerStreakLevel", 0.0)
	val perBad = tunableNumber(tunables, "inviteRedemptionCreditPerBad", 0.0)
	row["redemptionCredit"] = numberOrZero(row["redemptionCredit"]) + gain
	if (perStreak > 0) {
		while (numberOrZero(row["offenseStreak"]) > 0 && numberOrZero(row["redemptionCredit"]) >= perStreak) {
			row["redemptionCredit"] = numberOrZero(row["redemptionCredit"]) - perStreak
			row["offenseStreak"] = maxOf(0.0, numberOrZero(row["offenseStreak"]) - 1.0)
		}
		if (numberOrZero(row["offenseStreak"]) <= 0) {
			row.remove("offenseStreak")
			row.remove("lastOffenseAt")
		}
	}
	if (perBad > 0) {
		while (numberOrZero(row["badInviteeCount"]) > 0 && numberOrZero(row["redemptionCredit"]) >= perBad) {
			row["redemptionCredit"] = numberOrZero(row["redemptionCredit"]) - perBad
			row["badInviteeCount"] = maxOf(0.0, numberOrZero(row["badInviteeCount"]) - 1.0)
		}
		if (numberOrZero(row["badInviteeCount"]) <= 0)
			row.remove("badInviteeCount")
	}
	if (!numberOrZero(row["redemptionCredit"]).isFinite() || numberOrZero(row["redemptionCredit"]) <= 1e-9)
		row.remove("redemptionCredit")
}

/**
 * @param data 信誉表
 * @param nodeId 64 位十六进制
 * @param delta 增量
 * @param now 当前时间
 * @param tunables tunables
 */
fun adjustNodeReputation(
	data: MutableMap<String, Any?>,
	nodeId: String,
	delta: Double,
	now: Double = currentTimeMillisDouble(),
	tunables: Map<String, Any?> = defaultReputationTunables(),
) {
	val row = ensureRow(data, nodeId)
	var effectiveDelta = delta
	if (delta < 0) {
		val streak = numberOrZero(row["offenseStreak"]) + 1.0
		row["offenseStreak"] = streak
		row["lastOffenseAt"] = now
		effectiveDelta = delta * computeRecidivismMultiplier(streak, tunables)
	}
	else if (delta > 0)
		applyRedemptionFromGain(row, delta, tunables)

	row["score"] = clampReputationScore(numberOrZero(row["score"]) + effectiveDelta)
}

/**
 * @param data 信誉表
 * @param nodeId 64 位十六进制
 * @param badDelta 坏邀请计数增量
 */
fun incrementBadInviteeCount(data: MutableMap<String, Any?>, nodeId: String, badDelta: Double = 1.0) {
	if (badDelta <= 0) return
	val row = ensureRow(data, nodeId)
	row["badInviteeCount"] = maxOf(0.0, Math.floor(numberOrZero(row["badInviteeCount"]) + badDelta))
}

/**
 * @param data 磁盘 JSON（可信）
 * @return 补齐字段后的同一对象
 */
fun ensureReputationShape(data: MutableMap<String, Any?>): MutableMap<String, Any?> {
	// 无原型字典：键来自不可信 nodeHash，普通 `{}` 会让 `__proto__` 命中 Object.prototype（原型污染）。
	val source = Json.obj(data["byNodeHash"]) ?: emptyMap()
	val copy = LinkedHashMap<String, Any?>()
	for ((key, value) in source) copy[key] = value
	data["byNodeHash"] = copy
	if (data["wantUnknownHits"] == null || data["wantUnknownHits"] === JsonUndefined) data["wantUnknownHits"] = ArrayList<Any?>()
	if (data["relayBumpSeen"] == null || data["relayBumpSeen"] === JsonUndefined) data["relayBumpSeen"] = ArrayList<Any?>()
	return data
}

/**
 * @param data 信誉表
 * @param tunables tunables
 * @param now 当前时间
 * @return 裁剪后的同一对象
 */
fun pruneReputationFile(
	data: MutableMap<String, Any?>,
	tunables: Map<String, Any?> = defaultReputationTunables(),
	now: Double = currentTimeMillisDouble(),
): MutableMap<String, Any?> {
	val windowMs = tunableNumber(tunables, "wantUnknownWindowMs", Double.NaN)
	val dedupeMs = tunableNumber(tunables, "relayBumpDedupeMs", Double.NaN)
	data["wantUnknownHits"] = ArrayList(asList(data["wantUnknownHits"]).filter { now - jsNumberValue(Json.at(it, "t")) <= windowMs })
	val relay = ArrayList(asList(data["relayBumpSeen"]).filter { now - jsNumberValue(Json.at(it, "t")) <= dedupeMs })
	val maxKeep = tunableNumber(tunables, "maxRelayBumpSeen", 0.0)
	if (relay.size > maxKeep) {
		val start = if (maxKeep <= 0) 0 else maxOf(0, relay.size - maxKeep.toInt())
		data["relayBumpSeen"] = ArrayList(relay.subList(start, relay.size))
	}
	else
		data["relayBumpSeen"] = relay
	return data
}

/**
 * @param data 信誉表
 * @param peerNodeHash 对端节点
 * @param dedupeKey 去重键
 * @param now 当前时间
 * @param tunables tunables
 * @return 是否已加分
 */
fun bumpReputationOnRelayPure(
	data: MutableMap<String, Any?>,
	peerNodeHash: String?,
	dedupeKey: String? = null,
	now: Double = currentTimeMillisDouble(),
	tunables: Map<String, Any?> = defaultReputationTunables(),
): Boolean {
	val id = peerNodeHash
	if (id.isNullOrEmpty()) return false
	val key = if (!dedupeKey.isNullOrEmpty()) dedupeKey else "conn:$id"
	val dedupeMs = tunableNumber(tunables, "relayBumpDedupeMs", Double.NaN)
	val seen = ArrayList(asList(data["relayBumpSeen"]).filter { now - jsNumberValue(Json.at(it, "t")) <= dedupeMs })
	data["relayBumpSeen"] = seen
	if (relayBumpIsDuplicate(seen, id, key, now, dedupeMs)) return false
	seen.add(linkedMapOf("peerNodeHash" to id, "key" to key, "t" to now))
	adjustNodeReputation(data, id, tunableNumber(tunables, "relayRepBump", Double.NaN), now, tunables)
	return true
}

/**
 * @param data 信誉表
 * @param peerNodeHash 请求方
 * @param now 当前时间
 * @param tunables tunables
 * @return 是否触发惩罚
 */
fun recordGossipAllUnknownWantPure(
	data: MutableMap<String, Any?>,
	peerNodeHash: String,
	now: Double = currentTimeMillisDouble(),
	tunables: Map<String, Any?> = defaultReputationTunables(),
): Boolean {
	val windowMs = tunableNumber(tunables, "wantUnknownWindowMs", Double.NaN)
	val hits = ArrayList(asList(data["wantUnknownHits"]).filter { now - jsNumberValue(Json.at(it, "t")) <= windowMs })
	hits.add(linkedMapOf("peerNodeHash" to peerNodeHash, "t" to now))
	data["wantUnknownHits"] = hits
	val recent = hits.filter { Json.str(Json.at(it, "peerNodeHash")) == peerNodeHash }
	if (recent.size.toDouble() >= tunableNumber(tunables, "wantUnknownThreshold", Double.NaN)) {
		adjustNodeReputation(data, peerNodeHash, -tunableNumber(tunables, "penaltyUnknownWant", Double.NaN))
		data["wantUnknownHits"] = ArrayList(hits.filter { Json.str(Json.at(it, "peerNodeHash")) != peerNodeHash })
		return true
	}
	return false
}

/**
 * @param data 信誉表
 * @param peerNodeHash 对端
 * @param tunables tunables
 * @param excessRatio 超速超额比例 0..1
 */
fun recordMessageRateViolationPure(
	data: MutableMap<String, Any?>,
	peerNodeHash: String?,
	tunables: Map<String, Any?> = defaultReputationTunables(),
	excessRatio: Double = 1.0,
) {
	val id = peerNodeHash
	if (id.isNullOrEmpty()) return
	val raw = if (excessRatio.isNaN()) 0.0 else excessRatio
	val ratio = maxOf(0.0, minOf(1.0, raw))
	if (ratio <= 0) return
	adjustNodeReputation(data, id, -tunableNumber(tunables, "penaltyMessageRate", Double.NaN) * ratio)
}

/**
 * @param data 信誉表
 * @param storagePeerKey 责任方
 * @param tunables tunables
 */
fun bumpChunkStorageReputationPure(data: MutableMap<String, Any?>, storagePeerKey: String?, tunables: Map<String, Any?> = defaultReputationTunables()) {
	val id = storagePeerKey
	if (id.isNullOrEmpty()) return
	adjustNodeReputation(data, id, tunableNumber(tunables, "chunkStoreRepBump", Double.NaN))
}

/**
 * @param data 信誉表
 * @param blamePeerKey 责任方
 * @param tunables tunables
 */
fun penalizeChunkStorageFailurePure(data: MutableMap<String, Any?>, blamePeerKey: String?, tunables: Map<String, Any?> = defaultReputationTunables()) {
	val id = blamePeerKey
	if (id.isNullOrEmpty()) return
	adjustNodeReputation(data, id, -tunableNumber(tunables, "chunkFetchFailPenalty", Double.NaN))
}

/**
 * @param data 信誉表
 * @param peerNodeHash 对端 nodeHash
 * @param tunables tunables
 */
fun penalizeArchiveServeMismatchPure(data: MutableMap<String, Any?>, peerNodeHash: String?, tunables: Map<String, Any?> = defaultReputationTunables()) {
	val id = peerNodeHash
	if (id.isNullOrEmpty()) return
	adjustNodeReputation(data, id, -tunableNumber(tunables, "archiveServeMismatchPenalty", Double.NaN))
}

/**
 * @param data 信誉表
 * @param target 目标 nodeHash
 * @param sender 发送方 nodeHash
 * @param claim 主张强度
 * @param verified 是否可验证
 * @param tunables tunables
 */
fun applySubjectiveSlashPure(
	data: MutableMap<String, Any?>,
	target: String,
	sender: String,
	claim: Double,
	verified: Boolean,
	tunables: Map<String, Any?> = defaultReputationTunables(),
) {
	val repMaxEff = computeRepMaxEff(data)
	val repSender = scoreOf(data, sender)
	val penalty = subjectiveSlashPenalty(claim, repSender, repMaxEff, verified, tunables)
	adjustNodeReputation(data, target, -penalty)
}

/**
 * @param data 信誉表
 * @param targetPubKeyHash 目标
 * @param inviteEdges 邀请边
 * @param tunables tunables
 * @return 已应用的上游惩罚
 */
fun applyDecayCollusionAfterSlashPure(
	data: MutableMap<String, Any?>,
	targetPubKeyHash: String,
	inviteEdges: List<Any?>?,
	tunables: Map<String, Any?> = defaultReputationTunables(),
): List<AppliedDecay> {
	val target = targetPubKeyHash
	val applied = ArrayList<AppliedDecay>()
	var frontier: MutableSet<String> = LinkedHashSet(listOf(target))
	var maxBadSeen = 0.0
	val baseMaxHop = tunableNumber(tunables, "collusionMaxHop", 6.0)
	val hopBonusEvery = maxOf(1.0, tunableNumber(tunables, "inviteHopBonusEvery", 2.0))
	val hopBonusMax = tunableNumber(tunables, "inviteHopBonusMax", 0.0)
	val deltaBoostPerBad = tunableNumber(tunables, "inviteDeltaBoostPerBad", 0.0)
	val deltaBoostMax = tunableNumber(tunables, "inviteDeltaBoostMax", 0.0)

	fun effectiveMaxHop(): Double = baseMaxHop + minOf(hopBonusMax, Math.floor(maxBadSeen / hopBonusEvery))

	var hop = 1
	while (hop.toDouble() <= effectiveMaxHop()) {
		val upstream = LinkedHashSet<String>()
		for (edge in inviteEdges ?: emptyList()) {
			val to = Json.str(Json.at(edge, "to"))
			val from = Json.str(Json.at(edge, "from"))
			if (to != null && frontier.contains(to) && !from.isNullOrEmpty()) upstream.add(from)
		}
		if (upstream.isEmpty()) break

		for (node in upstream) {
			incrementBadInviteeCount(data, node, 1.0)
			val row = ensureRow(data, node)
			val badCount = numberOrZero(row["badInviteeCount"])
			maxBadSeen = maxOf(maxBadSeen, badCount)
			val boostedDelta = minOf(1.0, tunableNumber(tunables, "collusionDelta", 0.62) + minOf(deltaBoostMax, deltaBoostPerBad * badCount))
			val baseDRep = tunableNumber(tunables, "collusionLambda", 0.07) * Math.pow(boostedDelta, hop.toDouble())
			val dRep = baseDRep * computeInviteEscalation(badCount, tunables)
			val before = numberOrZero(row["score"])
			adjustNodeReputation(data, node, -dRep, currentTimeMillisDouble(), tunables)
			val after = scoreOf(data, node)
			applied.add(AppliedDecay(hop, node, before - after))
		}
		frontier = upstream
		hop++
	}
	return applied
}

/**
 * @param data 信誉表
 * @param targetPubKeyHash 目标
 */
fun applyReputationResetToScoresPure(data: MutableMap<String, Any?>, targetPubKeyHash: String) {
	val t = targetPubKeyHash
	val row = repRow(data, t)
	row["score"] = 0.0
	row.remove("offenseStreak")
	row.remove("lastOffenseAt")
	row.remove("badInviteeCount")
	row.remove("redemptionCredit")
	ensureByNodeHash(data)[t] = row
}

/**
 * @param data 信誉表
 * @param memberPubKeyHash 新成员
 * @param introducerPubKeyHash 介绍者
 * @param repEdge 边信任；省略则用 tunable introducerSeedEdge
 * @param tunables tunables
 * @param powBonus 入群 PoW 自愿封顶加成
 */
fun seedMemberReputationFromIntroducerPure(
	data: MutableMap<String, Any?>,
	memberPubKeyHash: String,
	introducerPubKeyHash: String?,
	repEdge: Double? = null,
	tunables: Map<String, Any?> = defaultReputationTunables(),
	powBonus: Double = 0.0,
) {
	val memberKey = memberPubKeyHash
	val introducerKey = introducerPubKeyHash
	val byNodeHash = ensureByNodeHash(data)
	if (jsTruthy(byNodeHash[memberKey])) return
	val introducerReputation = if (!introducerKey.isNullOrEmpty()) scoreOf(data, introducerKey) else 0.0
	byNodeHash[memberKey] = linkedMapOf<String, Any?>("score" to seedReputationFromIntro(introducerReputation, repEdge, tunables, powBonus))
}

/**
 * @param groupSettings 群设置
 * @param tunables tunables
 * @return 毫秒
 */
fun resolveSlashAlertTtlMsPure(groupSettings: Any?, tunables: Map<String, Any?> = defaultReputationTunables()): Double {
	val n = jsNumberValue(Json.at(groupSettings, "slashAlertTtl"))
	return if (n.isFinite() && n > 0) Math.floor(n) else tunableNumber(tunables, "defaultSlashAlertTtlMs", Double.NaN)
}

/**
 * @param row byNodeHash 行
 * @return 行为基线
 */
private fun baselineRow(row: Map<String, Any?>): Triple<Double, Double, Double> {
	val baseline = Json.obj(row["baseline"]) ?: emptyMap()
	return Triple(
		numberOrZero(baseline["mean"]),
		numberOrZero(baseline["m2"]),
		numberOrZero(baseline["count"]),
	)
}

/**
 * @param data 信誉表
 * @param peerNodeHash 对端
 * @param sample 观测值
 * @param now 当前时间
 * @param tunables tunables
 * @return 偏离度
 */
fun observeBehaviorSamplePure(
	data: MutableMap<String, Any?>,
	peerNodeHash: String?,
	sample: Double,
	now: Double = currentTimeMillisDouble(),
	tunables: Map<String, Any?> = defaultReputationTunables(),
): BehaviorSample {
	val id = peerNodeHash
	if (id.isNullOrEmpty()) return BehaviorSample(0.0, false)
	val row = repRow(data, id)
	val (baseMean, baseM2, baseCount) = baselineRow(row)
	val alpha = tunableNumber(tunables, "baselineAlpha", 0.08)
	val value = sample
	if (!value.isFinite()) return BehaviorSample(0.0, false)

	val prevMean = baseMean
	val prevCount = baseCount
	val newCount = prevCount + 1
	val newMean = if (prevCount == 0.0) value else prevMean + alpha * (value - prevMean)
	val newM2 = if (prevCount == 0.0) 0.0 else (1 - alpha) * (baseM2 + alpha * Math.pow(value - prevMean, 2.0))
	row["baseline"] = linkedMapOf<String, Any?>("mean" to newMean, "m2" to newM2, "count" to newCount)
	ensureByNodeHash(data)[id] = row

	val variance = if (newCount > 1) maxOf(newM2, 1e-6) else 0.0
	val std = Math.sqrt(variance)
	val z = if (std > 0) Math.abs(value - newMean) / std else 0.0
	val anomaly = newCount >= tunableNumber(tunables, "baselineMinSamples", 6.0) && z >= tunableNumber(tunables, "anomalyZThreshold", 2.8)
	if (anomaly)
		applyQuarantinePure(data, id, now, tunables)
	return BehaviorSample(z, anomaly)
}

/**
 * @param data 信誉表
 * @param peerNodeHash 对端
 * @param now 当前时间
 * @param tunables tunables
 */
fun applyQuarantinePure(
	data: MutableMap<String, Any?>,
	peerNodeHash: String?,
	now: Double = currentTimeMillisDouble(),
	tunables: Map<String, Any?> = defaultReputationTunables(),
) {
	val id = peerNodeHash
	if (id.isNullOrEmpty()) return
	val row = repRow(data, id)
	row["quarantinedUntil"] = now + tunableNumber(tunables, "quarantineTtlMs", 900_000.0)
	ensureByNodeHash(data)[id] = row
}

/**
 * @param data 信誉表
 * @param peerNodeHash 对端
 * @param now 当前时间
 * @return 是否处于本地隔离
 */
fun isQuarantinedPure(data: Map<String, Any?>?, peerNodeHash: String?, now: Double = currentTimeMillisDouble()): Boolean {
	val id = peerNodeHash ?: return false
	val until = jsNumberValue(Json.at(Json.at(Json.at(data, "byNodeHash"), id), "quarantinedUntil"))
	return until.isFinite() && until > now
}
