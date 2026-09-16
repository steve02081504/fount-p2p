package io.github.steve02081504.fountp2p.node

import io.github.steve02081504.fountp2p.core.JsonUndefined
import io.github.steve02081504.fountp2p.dag.sortedPrevEventIds
import io.github.steve02081504.fountp2p.governance.authzFoldOrderIds
import io.github.steve02081504.fountp2p.governance.descendantClosureFromTip
import io.github.steve02081504.fountp2p.governance.jsNumber

/**
 * 在共识分支上计算须保留的事件 id（连通子图，不用拓扑下标切片）。
 * @param order 规范拓扑序
 * @param byId id → 事件
 * @param options 保留策略
 * @param options.maxDepth 分支上最大事件深度
 * @param options.cutoffWall 最早保留的 HLC wall
 * @param options.anchorTypes 权限锚点事件类型
 * @param options.checkpointTipId checkpoint 尖
 * @param options.branchTipId 共识分支尖
 * @return 保留 id
 */
fun computeRetentionKeepIds(
	order: List<String>,
	byId: Map<String, Map<String, Any?>>,
	options: Map<String, Any?>,
): Set<String> {
	val maxDepth = jsNumber(options["maxDepth"])
	val cutoffWall = jsNumber(options["cutoffWall"])
	val anchorTypes = (options["anchorTypes"] as? Set<*>)?.filterIsInstance<String>()?.toSet() ?: emptySet()
	val checkpointTipId = options["checkpointTipId"] as? String
	val branchTipId = options["branchTipId"] as? String

	val branchOrder = authzFoldOrderIds(order, byId, branchTipId)
	val branchSet = branchOrder.toHashSet()
	if (branchSet.isEmpty()) return emptySet()

	val keep = LinkedHashSet<String>()
	val ancestorSeeds = LinkedHashSet<String>()

	if (!checkpointTipId.isNullOrEmpty() && checkpointTipId in branchSet)
		for (id in descendantClosureFromTip(checkpointTipId, byId))
			if (id in branchSet) keep.add(id)

	for (index in branchOrder.indices.reversed()) {
		val ev = byId[branchOrder[index]]
		val type = ev?.get("type")
		if (ev != null && type is String && type in anchorTypes) {
			ancestorSeeds.add(branchOrder[index])
			break
		}
	}

	for (id in branchOrder) {
		val ev = byId[id]
		val wallRaw = (ev?.get("hlc") as? Map<*, *>)?.get("wall")
		val wall = if (wallRaw == null || wallRaw === JsonUndefined) 0.0 else jsNumber(wallRaw)
		if (wall >= cutoffWall) ancestorSeeds.add(id)
	}

	if (branchOrder.size.toDouble() > maxDepth) {
		val depth = maxDepth.toInt()
		if (depth >= 0)
			for (id in branchOrder.takeLast(depth)) ancestorSeeds.add(id)
		else
			for (id in branchOrder.drop(-depth)) ancestorSeeds.add(id)
	}

	val stack = ArrayDeque<String>()
	for (id in ancestorSeeds) stack.addLast(id)
	while (stack.isNotEmpty()) {
		val id = stack.removeLast()
		if (id.isEmpty() || id !in branchSet || id in keep) continue
		keep.add(id)
		val event = byId[id] ?: continue
		for (parentId in sortedPrevEventIds(event["prev_event_ids"]))
			if (parentId in branchSet) stack.addLast(parentId)
	}

	if (keep.isEmpty())
		for (id in branchOrder) keep.add(id)

	return keep
}
