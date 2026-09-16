package io.github.steve02081504.fountp2p.trust_graph

import io.github.steve02081504.fountp2p.core.Json
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * 共享 tunables 缩放：ratio + floor + cap，仿真与运行时共用。
 *
 * 等价 `trust_graph/resolve.mjs`。
 */

/**
 * @param floor 下限
 * @param ratio 比例
 * @param cap 上限（缺省 +∞）
 */
class ScaleSpec(
	val floor: Double,
	val ratio: Double,
	val cap: Double = Double.POSITIVE_INFINITY,
)

/** 归档 quorum 阈值。 */
data class ArchiveQuorumThresholds(val peerMin: Int, val strictMin: Int)

/** 等价 JS `Number(value)`：非法文本得 `NaN`。 */
private fun jsNumber(value: Any?): Double = when (value) {
	null -> 0.0
	is Number -> value.toDouble()
	is Boolean -> if (value) 1.0 else 0.0
	is String -> {
		val text = value.trim()
		if (text.isEmpty()) 0.0 else text.toDoubleOrNull() ?: Double.NaN
	}
	else -> Double.NaN
}

/** 等价 JS `Number(value) || 0`。 */
private fun jsNumberOr(value: Any?): Double = jsNumber(value).let { if (it.isNaN()) 0.0 else it }

/**
 * @param n 分母（在场人数 / 候选 peer 数等）
 * @param spec floor、ratio、可选 cap
 * @return 有效整数阈值 ≥ floor
 */
fun scaleCount(n: Any?, spec: ScaleSpec): Int {
	val safeN = max(0.0, floor(jsNumberOr(n)))
	val product = safeN * spec.ratio
	val scaled = if (product.isNaN()) 0.0 else ceil(product)
	val capped = if (spec.cap.isFinite()) min(scaled, floor(spec.cap)) else scaled
	val bounded = if (safeN > 0) min(capped, safeN) else max(1.0, floor(spec.floor))
	return max(max(1.0, floor(spec.floor)), bounded).toInt()
}

/**
 * @param n 群 activeMembers 或联邦应答 peer 数
 * @param tunables 归档 tunables
 * @return 收集阶段 quorum peerMin
 */
fun resolveArchiveQuorumPeerMin(n: Any?, tunables: Map<String, Any?>): Int =
	scaleCount(
		n,
		ScaleSpec(
			floor = Json.num(tunables["archiveQuorumPeerMinFloor"])
				?: Json.num(tunables["archiveQuorumPeerMin"]) ?: 2.0,
			ratio = Json.num(tunables["archiveQuorumPeerMinRatio"]) ?: 0.25,
		),
	)

/**
 * @param n 群 activeMembers 或联邦应答 peer 数
 * @param tunables 归档 tunables
 * @return 无正信誉时 strictMin（硬钳 ≥2）
 */
fun resolveArchiveQuorumPeerStrictMin(n: Any?, tunables: Map<String, Any?>): Int {
	val raw = scaleCount(
		n,
		ScaleSpec(
			floor = Json.num(tunables["archiveQuorumPeerStrictMinFloor"])
				?: Json.num(tunables["archiveQuorumPeerStrictMin"]) ?: 2.0,
			ratio = Json.num(tunables["archiveQuorumPeerStrictMinRatio"]) ?: 0.5,
		),
	)
	return max(2, raw)
}

/**
 * @param peerCount 已知在线 relay 候选数
 * @param tunables 邮箱 tunables
 * @return 受信层 relay fanout
 */
fun resolveMailboxRelayFanout(peerCount: Any?, tunables: Map<String, Any?>): Int {
	val trusted = Json.num(tunables["relayFanoutTrusted"])
	if (trusted != null && trusted.isFinite())
		return max(
			1,
			min(if (jsNumber(peerCount) > 0) jsNumber(peerCount) else Double.POSITIVE_INFINITY, floor(trusted)).toInt(),
		)
	return scaleCount(
		peerCount,
		ScaleSpec(
			floor = Json.num(tunables["relayFanoutTrustedFloor"]) ?: 3.0,
			ratio = Json.num(tunables["relayFanoutTrustedRatio"]) ?: 0.3,
			cap = Json.num(tunables["relayFanoutTrustedCap"]) ?: 32.0,
		),
	)
}

/**
 * @param peerCount 已知在线 relay 候选数
 * @param tunables 邮箱 tunables
 * @return want 广播 fanout
 */
fun resolveMailboxWantFanout(peerCount: Any?, tunables: Map<String, Any?>): Int {
	val want = Json.num(tunables["wantFanout"])
	if (want != null && want.isFinite())
		return max(
			1,
			min(if (jsNumber(peerCount) > 0) jsNumber(peerCount) else Double.POSITIVE_INFINITY, floor(want)).toInt(),
		)
	return scaleCount(
		peerCount,
		ScaleSpec(
			floor = Json.num(tunables["wantFanoutFloor"]) ?: 3.0,
			ratio = Json.num(tunables["wantFanoutRatio"]) ?: 0.4,
			cap = Json.num(tunables["wantFanoutCap"]) ?: 32.0,
		),
	)
}

/**
 * @param rosterSize 信任图 roster 大小
 * @param tunables 信任图 tunables
 * @return 联邦 fanout Top-K
 */
fun resolveFederationFanoutTopK(rosterSize: Any?, tunables: Map<String, Any?>): Int {
	val topK = Json.num(tunables["federationFanoutTopK"])
	if (topK != null && topK.isFinite())
		return max(
			1,
			min(if (jsNumber(rosterSize) > 0) jsNumber(rosterSize) else Double.POSITIVE_INFINITY, floor(topK)).toInt(),
		)
	return scaleCount(
		rosterSize,
		ScaleSpec(
			floor = Json.num(tunables["federationFanoutTopKFloor"]) ?: 3.0,
			ratio = Json.num(tunables["federationFanoutTopKRatio"]) ?: 0.35,
			cap = Json.num(tunables["federationFanoutTopKCap"]) ?: 16.0,
		),
	)
}

/**
 * @param tunables 归档 tunables
 * @param activeMemberCount 群 active 成员数
 * @param candidatePeerCount 联邦候选 peer 数
 * @return 归档 quorum 阈值
 */
fun resolveArchiveQuorumThresholds(
	tunables: Map<String, Any?>,
	activeMemberCount: Any? = null,
	candidatePeerCount: Any? = null,
): ArchiveQuorumThresholds {
	val n = max(jsNumberOr(activeMemberCount), jsNumberOr(candidatePeerCount))
	return ArchiveQuorumThresholds(
		peerMin = resolveArchiveQuorumPeerMin(n, tunables),
		strictMin = resolveArchiveQuorumPeerStrictMin(n, tunables),
	)
}
