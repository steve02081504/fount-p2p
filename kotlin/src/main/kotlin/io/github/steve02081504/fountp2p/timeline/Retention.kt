package io.github.steve02081504.fountp2p.timeline

import io.github.steve02081504.fountp2p.dag.readJsonl
import io.github.steve02081504.fountp2p.dag.topologicalCanonicalOrder
import io.github.steve02081504.fountp2p.dag.writeJsonlSynced
import io.github.steve02081504.fountp2p.federation.invalidateTopologicalOrderMemo
import io.github.steve02081504.fountp2p.federation.jsNumber
import io.github.steve02081504.fountp2p.federation.jsNumberOr
import io.github.steve02081504.fountp2p.federation.jsTruthy
import io.github.steve02081504.fountp2p.governance.computeDagTipIdsFromEvents
import io.github.steve02081504.fountp2p.governance.selectConsensusBranchTip
import io.github.steve02081504.fountp2p.node.computeRetentionKeepIds
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.nio.file.Files
import java.nio.file.Paths

/**
 * 按保留策略裁剪 events.jsonl（连通子图，非拓扑下标切片）。
 * @param eventsFilePath events.jsonl 路径
 * @param checkpointHint 检查点提示
 * @param policy 保留策略（maxDepth / maxMs / anchorTypes）
 * @param sanitize 行规范化
 * @return 裁剪统计
 */
suspend fun enforceTimelineEventRetention(
	eventsFilePath: String,
	checkpointHint: Map<String, Any?>?,
	policy: Map<String, Any?>,
	sanitize: (Map<String, Any?>) -> Map<String, Any?> = { it },
): PruneStats {
	val events = readJsonl(eventsFilePath, sanitize)
	if (events.isEmpty()) return PruneStats(false, 0, 0)
	val maxDepth = maxOf(256.0, jsNumberOr(jsNumber(policy["maxDepth"]), 200_000.0))
	val maxMs = maxOf(3_600_000.0, jsNumberOr(jsNumber(policy["maxMs"]), 365.0 * 24 * 3600 * 1000))
	val cutoffWall = System.currentTimeMillis().toDouble() - maxMs
	val byId = LinkedHashMap<String, Map<String, Any?>>()
	for (event in events) {
		val id = event["id"] as? String ?: continue
		byId[id] = event
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
	val kept = order.mapNotNull { byId[it] }.filter { keepIds.contains(it["id"] as? String) }
	val dropped = events.size - kept.size
	if (dropped <= 0) return PruneStats(false, kept.size, 0)
	withContext(Dispatchers.IO) {
		Paths.get(eventsFilePath).parent?.let { Files.createDirectories(it) }
	}
	writeJsonlSynced(eventsFilePath, kept)
	invalidateTopologicalOrderMemo(eventsFilePath)
	return PruneStats(true, kept.size, dropped)
}
