package io.github.steve02081504.fountp2p.timeline

import io.github.steve02081504.fountp2p.dag.jsonlMutexKey
import io.github.steve02081504.fountp2p.dag.readJsonlEntries
import io.github.steve02081504.fountp2p.dag.topologicalCanonicalOrder
import io.github.steve02081504.fountp2p.dag.writeJsonlLines
import io.github.steve02081504.fountp2p.federation.invalidateTopologicalOrderMemo
import io.github.steve02081504.fountp2p.federation.jsTruthy
import io.github.steve02081504.fountp2p.governance.descendantClosureFromTip
import io.github.steve02081504.fountp2p.utils.withAsyncMutex

/** JSONL 裁剪统计。 */
data class PruneStats(val pruned: Boolean, val kept: Int, val dropped: Int)

/**
 * 将 events.jsonl 裁剪为 checkpoint 起后代闭包（连通子图，非拓扑下标切片）。
 *
 * 在 [jsonlMutexKey] per-file 互斥锁内完成读-算-写，避免与并发 append 的丢失更新；
 * 落盘时写回磁盘上的原始行（不做再序列化），保留 sanitize 剥离掉的字段与原始字节。
 * @param eventsFilePath events.jsonl 路径
 * @param checkpoint 含 checkpoint_event_id 的快照
 * @param sanitize 行规范化（仅影响计算，不影响落盘原始行）
 * @return 裁剪统计
 */
suspend fun pruneEventsJsonlAfterCheckpoint(
	eventsFilePath: String,
	checkpoint: Map<String, Any?>?,
	sanitize: (Map<String, Any?>) -> Map<String, Any?> = { it },
): PruneStats = withAsyncMutex(jsonlMutexKey(eventsFilePath)) {
	pruneEventsJsonlAfterCheckpointLocked(eventsFilePath, checkpoint, sanitize)
}

/** [pruneEventsJsonlAfterCheckpoint] 的持锁实现体。 */
private suspend fun pruneEventsJsonlAfterCheckpointLocked(
	eventsFilePath: String,
	checkpoint: Map<String, Any?>?,
	sanitize: (Map<String, Any?>) -> Map<String, Any?>,
): PruneStats {
	val tipRaw = checkpoint?.get("checkpoint_event_id")
	if (!jsTruthy(tipRaw)) return PruneStats(false, 0, 0)
	val entries = readJsonlEntries(eventsFilePath, sanitize)
	if (entries.isEmpty()) return PruneStats(false, 0, 0)
	val byId = LinkedHashMap<String, Map<String, Any?>>()
	val rawById = LinkedHashMap<String, String>()
	for (entry in entries) {
		val id = entry.row["id"] as? String ?: continue
		byId[id] = entry.row
		rawById[id] = entry.raw
	}
	val tipId = tipRaw as? String
	if (tipId == null || !byId.containsKey(tipId)) return PruneStats(false, entries.size, 0)

	val keepIds = descendantClosureFromTip(tipId, byId)
	val order = topologicalCanonicalOrder(entries.map { entry ->
		linkedMapOf<String, Any?>(
			"id" to entry.row["id"],
			"prev_event_ids" to entry.row["prev_event_ids"],
			"hlc" to entry.row["hlc"],
			"node_id" to entry.row["node_id"],
			"sender" to entry.row["sender"],
		)
	})
	val keptIds = order.filter { id -> keepIds.contains(id) && byId.containsKey(id) }
	val dropped = entries.size - keptIds.size
	if (dropped <= 0) return PruneStats(false, keptIds.size, 0)
	writeJsonlLines(eventsFilePath, keptIds.mapNotNull { rawById[it] })
	invalidateTopologicalOrderMemo(eventsFilePath)
	return PruneStats(true, keptIds.size, dropped)
}
