package io.github.steve02081504.fountp2p.governance

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.JsonUndefined
import io.github.steve02081504.fountp2p.dag.sortedPrevEventIds
import io.github.steve02081504.fountp2p.registries.getGovernanceAuthzTypes

/**
 * `governance/branch.mjs` 的等价实现：DAG 悬挂父检测、叶/祖先闭包计算与 §8 治理选支。
 */

// ─── JS 数值 / 字符串 / 真值语义辅助 ────────────────────────────────────────

/** 等价 JS `null` 或 `undefined` 判定（`??` 与 `== null`）。 */
internal fun isNullish(value: Any?): Boolean = value == null || value === JsonUndefined

/** 等价 JS `Number(value)`（ECMAScript ToNumber）。 */
internal fun jsNumber(value: Any?): Double = when (value) {
	null -> 0.0
	JsonUndefined -> Double.NaN
	is Boolean -> if (value) 1.0 else 0.0
	is Number -> value.toDouble()
	is String -> jsStringToNumber(value)
	else -> Double.NaN
}

/** 等价 JS `a || b`：`a` 为 NaN 或 ±0 时取 `b`。 */
internal fun jsNumberOr(value: Double, fallback: Double): Double =
	if (value.isNaN() || value == 0.0) fallback else value

/** 等价 JS `String(value)`。 */
internal fun jsString(value: Any?): String = when (value) {
	null -> "null"
	JsonUndefined -> "undefined"
	is String -> value
	is Boolean -> if (value) "true" else "false"
	is Number -> Json.jsNumberToString(value.toDouble())
	else -> value.toString()
}

/** 等价 JS 真值判定（`if (x)` / `!x`）。 */
internal fun jsTruthy(value: Any?): Boolean = when (value) {
	null, JsonUndefined -> false
	is Boolean -> value
	is Number -> {
		val d = value.toDouble()
		!d.isNaN() && d != 0.0
	}
	is String -> value.isNotEmpty()
	else -> true
}

private fun jsStringToNumber(text: String): Double {
	val trimmed = text.trim()
	if (trimmed.isEmpty()) return 0.0
	return when (trimmed) {
		"Infinity", "+Infinity" -> Double.POSITIVE_INFINITY
		"-Infinity" -> Double.NEGATIVE_INFINITY
		"NaN" -> Double.NaN
		else -> trimmed.removePrefix("+").toDoubleOrNull() ?: Double.NaN
	}
}

// ─── DAG 结构工具 ──────────────────────────────────────────────────────────

/**
 * 事件是否存在指向本地缺失父的悬挂引用（DAG 不完整）。
 * @param events 事件列表
 * @return 存在悬挂父则为 true
 */
fun hasDanglingParents(events: List<Map<String, Any?>>): Boolean {
	if (events.isEmpty()) return false
	val byId = LinkedHashMap<String, Map<String, Any?>>()
	for (event in events) {
		val id = event["id"] as? String ?: continue
		byId[id] = event
	}
	for (event in events)
		for (parentId in sortedPrevEventIds(event["prev_event_ids"]))
			if (!byId.containsKey(parentId)) return true
	return false
}

/**
 * 计算 DAG 叶事件 id。
 * @param events 事件列表
 * @return 叶 id 列表
 */
fun computeDagTipIdsFromEvents(events: List<Map<String, Any?>>): List<String> {
	if (events.isEmpty()) return emptyList()
	val referenced = HashSet<String>()
	for (event in events)
		for (parentId in sortedPrevEventIds(event["prev_event_ids"]))
			referenced.add(parentId)

	val tips = ArrayList<String>()
	for (event in events) {
		val id = event["id"] as? String
		if (!id.isNullOrEmpty() && id !in referenced) tips.add(id)
	}
	return tips
}

/**
 * 从 tip 沿父指针闭包祖先 id。
 * @param tipId 叶事件 id
 * @param byId id→事件
 * @return 祖先 id 集
 */
fun ancestorClosureFromTip(tipId: String?, byId: Map<String, Map<String, Any?>>): MutableSet<String> {
	val out = LinkedHashSet<String>()
	val stack = ArrayDeque<String>()
	if (!tipId.isNullOrEmpty()) stack.addLast(tipId)
	while (stack.isNotEmpty()) {
		val id = stack.removeLast()
		if (id.isEmpty() || out.contains(id)) continue
		out.add(id)
		val event = byId[id] ?: continue
		for (parentId in sortedPrevEventIds(event["prev_event_ids"]))
			if (byId.containsKey(parentId)) stack.addLast(parentId)
	}
	return out
}

/**
 * 构建 id → 子事件 id 列表（仅含图内边）。
 * @param byId id→事件
 * @return 父 id → 子 id 列表
 */
fun buildDagChildrenMap(byId: Map<String, Map<String, Any?>>): Map<String, MutableList<String>> {
	val children = LinkedHashMap<String, MutableList<String>>()
	for (event in byId.values) {
		val id = event["id"] as? String ?: continue
		for (parentId in sortedPrevEventIds(event["prev_event_ids"])) {
			if (!byId.containsKey(parentId)) continue
			children.getOrPut(parentId) { ArrayList() }.add(id)
		}
	}
	return children
}

/**
 * 从根沿子指针正向闭包（checkpoint 之后保留的后缀）。
 * @param rootId 根事件 id（通常为 checkpoint_event_id）
 * @param byId id→事件
 * @return 根及其后代 id
 */
fun descendantClosureFromTip(rootId: String?, byId: Map<String, Map<String, Any?>>): MutableSet<String> {
	if (rootId.isNullOrEmpty() || !byId.containsKey(rootId)) return LinkedHashSet()
	val children = buildDagChildrenMap(byId)
	val out = LinkedHashSet<String>()
	val stack = ArrayDeque<String>()
	stack.addLast(rootId)
	while (stack.isNotEmpty()) {
		val id = stack.removeLast()
		if (id.isEmpty() || out.contains(id)) continue
		out.add(id)
		for (childId in children[id] ?: emptyList<String>()) stack.addLast(childId)
	}
	return out
}

// ─── §8 治理选支 ───────────────────────────────────────────────────────────

/**
 * 该叶上治理事件信誉加权和。
 * @param tipId 叶 id
 * @param byId id→事件
 * @param reputationBySender 发送方主观信誉
 * @return 分数
 */
private fun governanceAuthzScoreForTip(
	tipId: String,
	byId: Map<String, Map<String, Any?>>,
	reputationBySender: Map<String, Any?>,
): Double {
	var score = 0.0
	val governanceTypes = getGovernanceAuthzTypes()
	for (eventId in ancestorClosureFromTip(tipId, byId)) {
		val event = byId[eventId] ?: continue
		val type = event["type"] as? String
		if (type == null || type !in governanceTypes) continue
		val sender = event["sender"]
		if (jsTruthy(sender)) {
			val raw = reputationBySender[jsString(sender)]
			score += if (isNullish(raw)) 0.0 else jsNumber(raw)
		}
	}
	return score
}

/**
 * 纯客观选支：仅统计治理事件数量，同分按 tipId 字典序（不读本地信誉）。
 * @param tips 当前叶 id 列表
 * @param byId id→事件
 * @return 选定 tip
 */
fun selectConsensusBranchTip(tips: List<String>, byId: Map<String, Map<String, Any?>>): String? {
	if (tips.isEmpty()) return null
	if (tips.size == 1) return tips[0]
	var best = tips[0]
	var bestScore = Double.NEGATIVE_INFINITY
	val governanceTypes = getGovernanceAuthzTypes()
	for (tip in tips) {
		var score = 0.0
		for (eventId in ancestorClosureFromTip(tip, byId)) {
			val event = byId[eventId] ?: continue
			val type = event["type"] as? String
			if (type != null && type in governanceTypes) score += 1.0
		}
		if (score > bestScore || (score == bestScore && tip > best)) {
			bestScore = score
			best = tip
		}
	}
	return best
}

/**
 * 主观选支（仅 UI 预览 `localViewBranchTip`；checkpoint/联邦/ACL 必须用 consensus）。
 * @param tips 当前叶 id 列表
 * @param byId id→事件
 * @param reputationBySender 发送方主观信誉
 * @param preferredTipId 用户显式选支
 * @return 选定 tip
 */
fun selectAuthzBranchTip(
	tips: List<String>,
	byId: Map<String, Map<String, Any?>>,
	reputationBySender: Map<String, Any?> = emptyMap(),
	preferredTipId: String? = null,
): String? {
	if (tips.isEmpty()) return null
	if (!preferredTipId.isNullOrEmpty() && preferredTipId in tips) return preferredTipId
	if (tips.size == 1) return tips[0]

	var best = tips[0]
	var bestScore = Double.NEGATIVE_INFINITY
	for (tip in tips) {
		val score = governanceAuthzScoreForTip(tip, byId, reputationBySender)
		if (score > bestScore || (score == bestScore && tip > best)) {
			bestScore = score
			best = tip
		}
	}
	return best
}

/**
 * 为每个 DAG 叶计算治理事件信誉加权和（§8 选支可视化）。
 * @param tips 叶 id 列表
 * @param byId id→事件
 * @param reputationBySender 发送方主观信誉
 * @return tipId → 分数
 */
fun computeTipAuthzScores(
	tips: List<String>,
	byId: Map<String, Map<String, Any?>>,
	reputationBySender: Map<String, Any?> = emptyMap(),
): Map<String, Double> {
	val out = LinkedHashMap<String, Double>()
	for (tip in tips) out[tip] = governanceAuthzScoreForTip(tip, byId, reputationBySender)
	return out
}

/**
 * 为每个 DAG 叶计算客观治理计数分（用于共识分支可视化）。
 * @param tips 叶 id 列表
 * @param byId id→事件
 * @return tipId → 客观分
 */
fun computeTipConsensusScores(tips: List<String>, byId: Map<String, Map<String, Any?>>): Map<String, Double> {
	val out = LinkedHashMap<String, Double>()
	val governanceTypes = getGovernanceAuthzTypes()
	for (tip in tips) {
		var score = 0.0
		for (eventId in ancestorClosureFromTip(tip, byId)) {
			val event = byId[eventId] ?: continue
			val type = event["type"] as? String
			if (type != null && type in governanceTypes) score += 1.0
		}
		out[tip] = score
	}
	return out
}

/**
 * 规范拓扑序中属于选定分支的事件 id。
 * @param topologicalOrder 拓扑序 id 列表
 * @param byId id→事件
 * @param branchTipId 分支尖
 * @return 可折叠的 id 子序列
 */
fun authzFoldOrderIds(
	topologicalOrder: List<String>,
	byId: Map<String, Map<String, Any?>>,
	branchTipId: String?,
): List<String> {
	if (branchTipId.isNullOrEmpty()) return topologicalOrder
	val allowed = ancestorClosureFromTip(branchTipId, byId)
	return topologicalOrder.filter { it in allowed }
}

/**
 * 是否存在未合并的治理分叉。
 * @param tips DAG 叶列表
 * @param branchTipId 当前权限分支尖
 * @return 多叶且已选支时为 true
 */
fun hasGovernanceFork(tips: List<String>, branchTipId: String?): Boolean =
	tips.size > 1 && !branchTipId.isNullOrEmpty()
