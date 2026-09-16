package io.github.steve02081504.fountp2p.reputation

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.JsonUndefined

/**
 * 主观信誉标量下界（§0.3）。
 */
const val REP_MIN: Double = -1.0

/**
 * 主观信誉标量上界（§0.3）。
 */
const val REP_MAX: Double = 1.0

/** §0.1：`rep_max_eff = max(已链邻居最大信誉, ε)` */
const val REP_MAX_EFF_EPS: Double = 1e-12

/** @return 当前毫秒时间戳（等价 JS `Date.now()`）。 */
internal fun currentTimeMillisDouble(): Double = System.currentTimeMillis().toDouble()

/**
 * 等价 JS `Number(value)` 的数值化。
 * @param v 任意值
 * @return 数值；无法数值化时为 NaN
 */
internal fun jsNumberValue(v: Any?): Double = when (v) {
	null, JsonUndefined -> Double.NaN
	is Number -> v.toDouble()
	is Boolean -> if (v) 1.0 else 0.0
	is String -> {
		val text = v.trim()
		if (text.isEmpty()) 0.0 else text.toDoubleOrNull() ?: Double.NaN
	}
	else -> Double.NaN
}

/**
 * 等价 JS 真值判定（用于 `if (x)` / `!x`）。
 * @param v 任意值
 * @return 是否 JS 真值
 */
internal fun jsTruthy(v: Any?): Boolean = when (v) {
	null, JsonUndefined -> false
	is Boolean -> v
	is Number -> {
		val d = v.toDouble()
		!d.isNaN() && d != 0.0
	}
	is String -> v.isNotEmpty()
	else -> true
}

/**
 * 等价 JS `tunables[key] ?? fallback`（仅在键缺失/null 时兜底，不做数值化兜底）。
 * @param tunables tunables 表
 * @param key 键
 * @param fallback 缺失时的兜底值
 * @return 数值
 */
internal fun tunableNumber(tunables: Map<String, Any?>, key: String, fallback: Double): Double {
	val raw = tunables[key]
	return if (raw == null || raw === JsonUndefined) fallback else jsNumberValue(raw)
}

/**
 * @param x 任意标量
 * @return clamp 到 [-1, 1]
 */
fun clampReputationScore(x: Double): Double = minOf(REP_MAX, maxOf(REP_MIN, x))

/**
 * @param data 信誉表
 * @return `max(已链邻居最大信誉, ε)`（§0.1 `rep_max_eff`）
 */
fun computeRepMaxEff(data: Map<String, Any?>?): Double {
	var maxScore: Double? = null
	val byNodeHash = Json.obj(Json.at(data, "byNodeHash"))
	if (byNodeHash != null) {
		for (nodeId in byNodeHash.keys) {
			val score = jsNumberValue(Json.at(byNodeHash[nodeId], "score"))
			if (!score.isFinite()) continue
			// rep_max_eff 仅由「可施加影响」的正信誉邻居定义，避免全负信誉集把分母压成异常值。
			if (score <= 0) continue
			maxScore = if (maxScore == null) score else maxOf(maxScore, score)
		}
	}
	return maxOf(maxScore?.let { clampReputationScore(it) } ?: 0.0, REP_MAX_EFF_EPS)
}

/**
 * 不可验证 Slash 落地扣分（§0.1）。
 * @param claim 主张强度
 * @param repSender 发送方信誉
 * @param repMaxEff 分母
 * @param verified 是否可验证
 * @param tunables tunables
 * @return 对目标的扣分幅度（正数）
 */
fun subjectiveSlashPenalty(
	claim: Double,
	repSender: Double,
	repMaxEff: Double,
	verified: Boolean = false,
	tunables: Map<String, Any?> = defaultReputationTunables(),
): Double {
	val claimStrength = if (claim.isFinite()) claim else tunableNumber(tunables, "slashDefaultClaim", Double.NaN)
	val senderInfluence = maxOf(0.0, if (repSender.isFinite()) repSender else 0.0)
	return if (verified)
		Math.abs(claimStrength) * tunableNumber(tunables, "slashVerifiedMultiplier", Double.NaN)
	else
		Math.abs((claimStrength * senderInfluence) / repMaxEff)
}

/**
 * §0.3 初值：`clamp(rep_local(intro) * reputationEdge)`。
 *
 * `repEdge` 缺省时退回 tunable `introducerSeedEdge`（抗女巫杠杆：边信任越低，
 * 新成员从介绍者继承的初始信誉越少，邀请链批量灌号的收益越小）。
 * @param introRep 介绍者信誉
 * @param repEdge 边信任；省略则用 tunable 默认
 * @param tunables tunables
 * @param powBonus 入群 PoW 自愿封顶加成
 * @return 新成员初值
 */
fun seedReputationFromIntro(
	introRep: Double,
	repEdge: Double? = null,
	tunables: Map<String, Any?> = defaultReputationTunables(),
	powBonus: Double = 0.0,
): Double {
	val edge = if (repEdge != null && repEdge.isFinite()) repEdge else tunableNumber(tunables, "introducerSeedEdge", Double.NaN)
	val base = introRep * (if (edge.isFinite()) clampReputationScore(edge) else 1.0)
	val bonus = if (powBonus.isFinite() && powBonus > 0) powBonus else 0.0
	return clampReputationScore(base + bonus)
}
