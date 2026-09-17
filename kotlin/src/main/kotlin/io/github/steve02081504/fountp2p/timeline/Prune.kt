package io.github.steve02081504.fountp2p.timeline

import io.github.steve02081504.fountp2p.dag.readJsonl
import io.github.steve02081504.fountp2p.dag.topologicalCanonicalOrder
import io.github.steve02081504.fountp2p.dag.writeJsonlSynced
import io.github.steve02081504.fountp2p.federation.invalidateTopologicalOrderMemo
import io.github.steve02081504.fountp2p.federation.jsTruthy
import io.github.steve02081504.fountp2p.governance.descendantClosureFromTip
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.nio.file.Files
import java.nio.file.Paths

/** JSONL 裁剪统计。 */
data class PruneStats(val pruned: Boolean, val kept: Int, val dropped: Int)

/**
 * 将 events.jsonl 裁剪为 checkpoint 起后代闭包（连通子图，非拓扑下标切片）。
 * @param eventsFilePath events.jsonl 路径
 * @param checkpoint 含 checkpoint_event_id 的快照
 * @param sanitize 行规范化
 * @return 裁剪统计
 */
suspend fun pruneEventsJsonlAfterCheckpoint(
	eventsFilePath: String,
	checkpoint: Map<String, Any?>?,
	sanitize: (Map<String, Any?>) -> Map<String, Any?> = { it },
): PruneStats {
	val tipRaw = checkpoint?.get("checkpoint_event_id")
	if (!jsTruthy(tipRaw)) return PruneStats(false, 0, 0)
	val events = readJsonl(eventsFilePath, sanitize)
	if (events.isEmpty()) return PruneStats(false, 0, 0)
	val byId = LinkedHashMap<String, Map<String, Any?>>()
	for (dagEvent in events) {
		val id = dagEvent["id"] as? String ?: continue
		byId[id] = dagEvent
	}
	val tipId = tipRaw as? String
	if (tipId == null || !byId.containsKey(tipId)) return PruneStats(false, events.size, 0)

	val keepIds = descendantClosureFromTip(tipId, byId)
	val order = topologicalCanonicalOrder(events.map { dagEvent ->
		linkedMapOf<String, Any?>(
			"id" to dagEvent["id"],
			"prev_event_ids" to dagEvent["prev_event_ids"],
			"hlc" to dagEvent["hlc"],
			"node_id" to dagEvent["node_id"],
			"sender" to dagEvent["sender"],
		)
	})
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
