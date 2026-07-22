import { normalizeHex64 } from '../core/hexIds.mjs'
import { getReputationTable } from '../node/reputation_sync.mjs'
import { pickNodeScoreFromReputation } from '../reputation/pick_score.mjs'
import { getLinkRegistry } from '../transport/link_registry.mjs'


/** @type {{ useLocalReputation: boolean }} */
let priorityConfig = { useLocalReputation: false }

const PRIORITY_BOOST = 1000

/**
 * 配置 infra 路由加权（是否用本地 reputation）。
 * @param {{ useLocalReputation?: boolean }} config - 是否用本地 reputation 加权路由
 * @returns {void}
 */
export function setInfraPriority(config = {}) {
	priorityConfig = {
		useLocalReputation: Boolean(config.useLocalReputation),
	}
	applyPriorityToRegistry()
}

/**
 * @returns {{ useLocalReputation: boolean }} 当前 priority 配置副本
 */
export function getInfraPriority() {
	return { ...priorityConfig }
}

/**
 * @returns {void}
 */
export function applyPriorityToRegistry() {
	const registry = getLinkRegistry()
	if (!priorityConfig.useLocalReputation) {
		registry.setPriorityWeightFunction(null)
		return
	}
	registry.setPriorityWeightFunction(nodeHash => {
		const score = pickNodeScoreFromReputation(
			getReputationTable(),
			normalizeHex64(nodeHash) || nodeHash,
		)
		return Math.floor(score * PRIORITY_BOOST)
	})
}

/**
 * stopInfra：卸 weight，并重置 priority 配置，避免再次 startInfra 幽灵恢复加权。
 * @returns {void}
 */
export function clearInfraPriorityFromRegistry() {
	priorityConfig = { useLocalReputation: false }
	getLinkRegistry().setPriorityWeightFunction(null)
}
