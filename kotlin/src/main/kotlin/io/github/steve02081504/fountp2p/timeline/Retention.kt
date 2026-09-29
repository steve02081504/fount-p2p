package io.github.steve02081504.fountp2p.timeline

import io.github.steve02081504.fountp2p.dag.jsonlMutexKey
import io.github.steve02081504.fountp2p.dag.readJsonlEntries
import io.github.steve02081504.fountp2p.dag.topologicalCanonicalOrder
import io.github.steve02081504.fountp2p.dag.writeJsonlLines
import io.github.steve02081504.fountp2p.federation.invalidateTopologicalOrderMemo
import io.github.steve02081504.fountp2p.federation.jsNumber
import io.github.steve02081504.fountp2p.federation.jsNumberOr
import io.github.steve02081504.fountp2p.federation.jsTruthy
import io.github.steve02081504.fountp2p.governance.computeDagTipIdsFromEvents
import io.github.steve02081504.fountp2p.governance.selectConsensusBranchTip
import io.github.steve02081504.fountp2p.node.computeRetentionKeepIds
import io.github.steve02081504.fountp2p.utils.withAsyncMutex

/**
 * 按保留策略裁剪 events.jsonl（连通子图，非拓扑下标切片）。
 *
 * 在 [jsonlMutexKey] per-file 互斥锁内完成读-算-写，避免与并发 append 的丢失更新；
 * 落盘时写回磁盘上的原始行（不做再序列化），保留 sanitize 剥离掉的字段与原始字节。
 * @param eventsFilePath events.jsonl 路径
 * @param checkpointHint 检查点提示
 * @param policy 保留策略（maxDepth / maxMs / anchorTypes）
 * @param sanitize 行规范化（仅影响计算，不影响落盘原始行）
 * @return 裁剪统计
 */
suspend fun enforceTimelineEventRetention(
	eventsFilePath: String,
	checkpointHint: Map<String, Any?>?,
	policy: Map<String, Any?>,
	sanitize: (Map<String, Any?>) -> Map<String, Any?> = { it },
): PruneStats = withAsyncMutex(jsonlMutexKey(eventsFilePath)) {
	enforceTimelineEventRetentionLocked(eventsFilePath, checkpointHint, policy, sanitize)
}

/** [enforceTimelineEventRetention] 的持锁实现体。 */
private suspend fun enforceTimelineEventRetentionLocked(
	eventsFilePath: String,
	checkpointHint: Map<String, Any?>?,
	policy: Map<String, Any?>,
	sanitize: (Map<String, Any?>) -> Map<String, Any?>,
): PruneStats {
	val entries = readJsonlEntries(eventsFilePath, sanitize)
	if (entries.isEmpty()) return PruneStats(false, 0, 0)
	val maxDepth = maxOf(256.0, jsNumberOr(jsNumber(policy["maxDepth"]), 200_000.0))
	val maxMs = maxOf(3_600_000.0, jsNumberOr(jsNumber(policy["maxMs"]), 365.0 * 24 * 3600 * 1000))
	val cutoffWall = System.currentTimeMillis().toDouble() - maxMs
	val events = entries.map { it.row }
	val byId = LinkedHashMap<String, Map<String, Any?>>()
	val rawById = LinkedHashMap<String, String>()
	for (entry in entries) {
		val id = entry.row["id"] as? String ?: continue
		byId[id] = entry.row
		rawById[id] = entry.raw
	}
	val order = topologicalCanonicalOrder(events.map { event ->
		linkedMapOf<String, Any?>(
			"id" to event["id"],
			"prev_event_ids" to event["prev_event_ids"],
			"hlc" to event["hlc"],
			"node_id" to event["node_id"],
			"sender" to event["sender"],
		)
	})
	val tips = computeDagTipIdsFromEvents(events)
	val branchTipId = selectConsensusBranchTip(tips, byId)
	val checkpointRaw = checkpointHint?.get("checkpoint_event_id")
	val checkpointTipId = if (jsTruthy(checkpointRaw)) checkpointRaw else null
	val keepIds = computeRetentionKeepIds(
		order,
		byId,
		linkedMapOf(
			"maxDepth" to maxDepth,
			"cutoffWall" to cutoffWall,
			"anchorTypes" to policy["anchorTypes"],
			"checkpointTipId" to checkpointTipId,
			"branchTipId" to branchTipId,
		),
	)
	if (keepIds.size >= events.size) return PruneStats(false, events.size, 0)
	val keptIds = order.filter { id -> keepIds.contains(id) && byId.containsKey(id) }
	val dropped = events.size - keptIds.size
	if (dropped <= 0) return PruneStats(false, keptIds.size, 0)
	writeJsonlLines(eventsFilePath, keptIds.mapNotNull { rawById[it] })
	invalidateTopologicalOrderMemo(eventsFilePath)
	return PruneStats(true, keptIds.size, dropped)
}
