package io.github.steve02081504.fountp2p.node

/**
 * 通用包级行为开关（布尔 feature map）：`{ census: true, ... }`。
 * 新增功能只需加入新布尔 key，无需新增专属设置界面。
 */

/** 默认 feature：census 默认开启（人口统计，基于 nostr）。 */
private val DEFAULT_P2P_FEATURES: Map<String, Any?> = linkedMapOf("census" to true)

/** @return 默认 feature map 快照 */
fun defaultP2PFeatures(): Map<String, Any?> = LinkedHashMap(DEFAULT_P2P_FEATURES)

/**
 * 归一化 feature map：已知 key 用默认值，patch 中未知 key 原样透传（值必须为 boolean）。
 * @param patch 部分 feature 覆盖
 * @return 完整 boolean feature map
 */
fun resolveP2PFeatures(patch: Map<String, Any?>? = null): Map<String, Any?> {
	val out = LinkedHashMap<String, Any?>(defaultP2PFeatures())
	for ((key, value) in patch ?: emptyMap<String, Any?>()) {
		if (value != true && value != false)
			throw IllegalArgumentException("p2p: feature \"$key\" must be boolean")
		out[key] = value
	}
	return out
}
