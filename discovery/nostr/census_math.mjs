/**
 * 人口统计采样纯函数：HT 估计 + 包含概率反馈更新。
 * 修正历史公式：估计用 `Σ(1/p)`（除以包含概率），更新用 `p' = p·(T/E)`（乘性），
 * 而非 `Σp/2`（规模越大越失真）或 `T/(Σp/2)`（事件数随 M^(2/3) 发散）。
 */

/** 理想窗口事件数 */
export const CENSUS_TARGET_EVENTS = 20
/** 包含概率下限（E==0 探测增长的上限 clamp 由调用方保证） */
export const CENSUS_MIN_P = 0.001
/** E==0 时概率增长因子 */
export const CENSUS_GROW_FACTOR = 1.5

/**
 * clamp 包含概率到 [minP, 1]；非有限值回落 minP。
 * @param {unknown} p 原始概率
 * @returns {number} 规范化概率
 */
export function clampP(p) {
	const value = Number(p)
	if (!Number.isFinite(value)) return CENSUS_MIN_P
	return Math.min(1, Math.max(CENSUS_MIN_P, value))
}

/**
 * 下一轮包含概率：观察到 E 条、目标 T 条，按 T/E 乘性缩放；E==0 时向上探测。
 * @param {number} currentP 当前包含概率
 * @param {number} observedCount 窗口内观察到的事件数 E
 * @param {number} [target=CENSUS_TARGET_EVENTS] 目标事件数 T
 * @returns {number} 下一轮包含概率
 */
export function nextInclusionProbability(currentP, observedCount, target = CENSUS_TARGET_EVENTS) {
	const observed = Math.max(0, Math.floor(Number(observedCount) || 0))
	const targetEvents = Math.max(1, Math.floor(Number(target) || CENSUS_TARGET_EVENTS))
	const base = clampP(currentP)
	if (observed === 0) return clampP(base * CENSUS_GROW_FACTOR)
	return clampP(base * (targetEvents / observed))
}

/**
 * HT 估计在线节点数：对每个有效采样事件累加 `1/p`。
 * 剔除 p 非法（≤0 / >1 / 非有限）或已过期（超出 ttlMs）的事件。
 * @param {Array<{ p?: unknown, at?: unknown }>} events 采样事件（含包含概率与时间戳）
 * @param {number} [now=Date.now()] 当前时间（毫秒）
 * @param {number} [ttlMs=10 * 60_000] 窗口 TTL（毫秒）
 * @returns {{ estimate: number, sampleSize: number }} 估计值与有效采样数
 */
export function estimatePopulation(events, now = Date.now(), ttlMs = 10 * 60_000) {
	let total = 0
	let sampleSize = 0
	for (const event of events || []) {
		const p = Number(event?.p)
		const at = Number(event?.at)
		if (!Number.isFinite(p) || p <= 0 || p > 1) continue
		if (!Number.isFinite(at) || now - at > ttlMs) continue
		total += 1 / p
		sampleSize++
	}
	return { estimate: total, sampleSize }
}