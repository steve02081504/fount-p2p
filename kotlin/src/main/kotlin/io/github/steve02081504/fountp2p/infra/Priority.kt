package io.github.steve02081504.fountp2p.infra

import io.github.steve02081504.fountp2p.node.loadReputation
import io.github.steve02081504.fountp2p.reputation.pickNodeScoreFromReputation
import io.github.steve02081504.fountp2p.transport.getLinkRegistry

private var priorityConfig: Map<String, Any?> = mapOf("useLocalReputation" to false)

private const val PRIORITY_BOOST = 1000

/**
 * 配置 infra 路由加权（是否用本地 reputation）。
 * @param config 是否用本地 reputation 加权路由
 */
fun setInfraPriority(config: Map<String, Any?> = emptyMap()) {
	priorityConfig = mapOf("useLocalReputation" to (config["useLocalReputation"] == true))
	applyPriorityToRegistry()
}

/** @return 当前 priority 配置副本 */
fun getInfraPriority(): Map<String, Any?> = LinkedHashMap(priorityConfig)

/** 将优先级配置应用到 link registry */
fun applyPriorityToRegistry() {
	val registry = getLinkRegistry()
	if (priorityConfig["useLocalReputation"] != true) {
		registry.setPriorityWeightFunction(null)
		return
	}
	registry.setPriorityWeightFunction { nodeHash ->
		Math.floor(pickNodeScoreFromReputation(loadReputation(), nodeHash) * PRIORITY_BOOST)
	}
}

/**
 * stopInfra：卸 weight，并重置 priority 配置，避免再次 startInfra 幽灵恢复加权。
 */
fun clearInfraPriorityFromRegistry() {
	priorityConfig = mapOf("useLocalReputation" to false)
	getLinkRegistry().setPriorityWeightFunction(null)
}
