/**
 * 通用包级行为开关（布尔 feature map）：`{ census: true, ... }`。
 * 新增功能只需加入新布尔 key，无需新增专属设置界面。
 */

/** 默认 feature：census 默认开启（人口统计，基于 nostr）。 */
const DEFAULT_P2P_FEATURES = { census: true }

/**
 * @returns {Record<string, boolean>} 默认 feature map 快照
 */
export function defaultP2PFeatures() {
	return { ...DEFAULT_P2P_FEATURES }
}

/**
 * 归一化 feature map：已知 key 用默认值，patch 中未知 key 原样透传（值必须为 boolean）。
 * @param {Record<string, boolean> | undefined | null} [patch] 部分 feature 覆盖
 * @returns {Record<string, boolean>} 完整 boolean feature map
 */
export function resolveP2PFeatures(patch = {}) {
	if (!patch || typeof patch !== 'object') return defaultP2PFeatures()
	/** @type {Record<string, boolean>} */
	const out = defaultP2PFeatures()
	for (const [key, value] of Object.entries(patch)) {
		if (value !== true && value !== false)
			throw new Error(`p2p: feature "${key}" must be boolean`)
		out[key] = value
	}
	return out
}