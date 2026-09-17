package io.github.steve02081504.fountp2p.discovery.nostr

/**
 * 人口统计采样纯函数：HT 估计 + 包含概率反馈更新（等价 `census_math.mjs`）。
 */

/** 理想窗口事件数 */
const val CENSUS_TARGET_EVENTS = 20

/** 包含概率下限 */
const val CENSUS_MIN_P = 0.001

/** E==0 时概率增长因子 */
const val CENSUS_GROW_FACTOR = 1.5

/**
 * clamp 包含概率到 `[minP, 1]`；非有限值回落 minP。
 * @param p 原始概率
 * @return 规范化概率
 */
fun clampP(p: Any?): Double {
	val value = (p as? Number)?.toDouble() ?: return CENSUS_MIN_P
	if (value.isNaN() || value.isInfinite()) return CENSUS_MIN_P
	return minOf(1.0, maxOf(CENSUS_MIN_P, value))
}

/**
 * 下一轮包含概率：观察到 E 条、目标 T 条，按 T/E 乘性缩放；E==0 时向上探测。
 * @param currentP 当前包含概率
 * @param observedCount 窗口内观察到的事件数 E
 * @param target 目标事件数 T
 * @return 下一轮包含概率
 */
@JvmOverloads
fun nextInclusionProbability(currentP: Any?, observedCount: Any?, target: Any? = CENSUS_TARGET_EVENTS): Double {
	val base = clampP(currentP)
	val observed = (observedCount as? Number)?.toDouble() ?: 0.0
	if (observed == 0.0) return clampP(base * CENSUS_GROW_FACTOR)
	val targetValue = (target as? Number)?.toDouble() ?: CENSUS_TARGET_EVENTS.toDouble()
	return clampP(base * (maxOf(1.0, targetValue) / observed))
}

/** HT 估计结果。 */
data class PopulationEstimate(val estimate: Double, val sampleSize: Int)

/**
 * HT 估计在线节点数：对每个有效采样事件累加 `1/p`。
 * 剔除 p 非法（≤0 / >1 / 非有限）。
 * @param events 采样事件（含包含概率 p）
 * @return 估计值与有效采样数
 */
fun estimatePopulation(events: List<Any?>?): PopulationEstimate {
	var total = 0.0
	var sampleSize = 0
	for (event in events ?: emptyList()) {
		val p = ((event as? Map<*, *>)?.get("p") as? Number)?.toDouble() ?: continue
		if (p.isNaN() || p.isInfinite() || p <= 0.0 || p > 1.0) continue
		total += 1 / p
		sampleSize++
	}
	return PopulationEstimate(total, sampleSize)
}
