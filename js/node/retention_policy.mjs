import { sortedPrevEventIds } from '../dag/index.mjs'
import {
	authzFoldOrderIds,
	descendantClosureFromTip,
} from '../governance/branch.mjs'

/**
 * 在共识分支上计算须保留的事件 id（连通子图，不用拓扑下标切片）。
 * @param {string[]} order 规范拓扑序
 * @param {Map<string, object>} byId id → 事件
 * @param {object} options 保留策略
 * @param {number} options.maxDepth 分支上最大事件深度
 * @param {number} options.cutoffWall 最早保留的 HLC wall
 * @param {Set<string>} options.anchorTypes 权限锚点事件类型
 * @param {string | null} [options.checkpointTipId] checkpoint 尖
 * @param {string | null} [options.branchTipId] 共识分支尖
 * @returns {Set<string>} 保留 id
 */
export function computeRetentionKeepIds(order, byId, options) {
	const { maxDepth, cutoffWall, anchorTypes, checkpointTipId, branchTipId } = options
	const branchOrder = authzFoldOrderIds(order, byId, branchTipId)
	const branchSet = new Set(branchOrder)
	if (!branchSet.size) return new Set()

	/** @type {Set<string>} */
	const keep = new Set()
	/** @type {Set<string>} */
	const ancestorSeeds = new Set()

	if (checkpointTipId && branchSet.has(checkpointTipId))
		for (const id of descendantClosureFromTip(checkpointTipId, byId))
			if (branchSet.has(id)) keep.add(id)

	for (let index = branchOrder.length - 1; index >= 0; index--) {
		const ev = byId.get(branchOrder[index])
		if (ev && anchorTypes.has(ev.type)) {
			ancestorSeeds.add(branchOrder[index])
			break
		}
	}

	for (const id of branchOrder) {
		const ev = byId.get(id)
		const wall = Number(ev?.hlc?.wall ?? 0)
		if (wall >= cutoffWall) ancestorSeeds.add(id)
	}

	if (branchOrder.length > maxDepth)
		for (const id of branchOrder.slice(-maxDepth))
			ancestorSeeds.add(id)

	const stack = [...ancestorSeeds]
	while (stack.length) {
		const id = stack.pop()
		if (!id || !branchSet.has(id) || keep.has(id)) continue
		keep.add(id)
		const event = byId.get(id)
		if (!event) continue
		for (const parentId of sortedPrevEventIds(event.prev_event_ids))
			if (branchSet.has(parentId)) stack.push(parentId)
	}

	if (!keep.size)
		for (const id of branchOrder) keep.add(id)

	return keep
}
