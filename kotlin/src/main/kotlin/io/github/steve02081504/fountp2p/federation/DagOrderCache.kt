package io.github.steve02081504.fountp2p.federation

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.dag.computeLocalTipsHash
import io.github.steve02081504.fountp2p.dag.eventsToMetas
import io.github.steve02081504.fountp2p.dag.sortedPrevEventIds
import io.github.steve02081504.fountp2p.dag.topologicalCanonicalOrder
import io.github.steve02081504.fountp2p.governance.computeDagTipIdsFromEvents
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.nio.file.Files
import java.nio.file.Paths

// DAG 拓扑序磁盘缓存（events.order.json）：增量合并，避免每次全量 Kahn。

/**
 * 将新增事件按父指针插入已有拓扑序之后。
 * @param cachedOrder 已缓存序
 * @param events 全量事件
 * @return 合并后的 id 序
 */
fun mergeTopologicalOrder(cachedOrder: List<String>, events: List<Map<String, Any?>>): List<String> {
	val byId = LinkedHashMap<String, Map<String, Any?>>()
	for (event in events) {
		val id = event["id"] as? String ?: continue
		byId[id] = event
	}
	val merged = ArrayList(cachedOrder.filter { byId.containsKey(it) })
	val orderSet = HashSet(merged)
	val newEvents = events.filter { event ->
		val id = event["id"]
		id !is String || id !in orderSet
	}
	if (newEvents.isEmpty()) return merged

	val newOrder = topologicalCanonicalOrder(eventsToMetas(newEvents))
	for (id in newOrder) {
		if (orderSet.contains(id)) continue
		val event = byId[id]
		var insertAt = merged.size
		for (parentId in sortedPrevEventIds(event?.get("prev_event_ids"))) {
			val parentIdx = merged.indexOf(parentId)
			if (parentIdx >= 0) insertAt = maxOf(insertAt, parentIdx + 1)
		}
		merged.add(insertAt, id)
		orderSet.add(id)
	}
	return merged
}

/**
 * 解析事件拓扑序（优先复用磁盘缓存，必要时增量合并）。
 * @param events 全量事件
 * @param cache 磁盘缓存
 * @param options `forceFull` 为真时强制全量重算
 * @return 拓扑序 id 列表
 */
fun resolveEventTopologicalOrder(
	events: List<Map<String, Any?>>,
	cache: Map<String, Any?>?,
	options: Map<String, Any?> = emptyMap(),
): List<String> {
	if (events.isEmpty()) return emptyList()
	if (jsTruthy(options["forceFull"]))
		return topologicalCanonicalOrder(eventsToMetas(events))

	val byId = LinkedHashMap<String, Map<String, Any?>>()
	for (event in events) {
		val id = event["id"] as? String ?: continue
		byId[id] = event
	}
	val tips = computeDagTipIdsFromEvents(events)
	val tipsHash = computeLocalTipsHash(tips)
	val eventCount = events.size

	val rawOrder = cache?.get("order") as? List<*>
	if (!rawOrder.isNullOrEmpty()) {
		val cachedOrder = rawOrder.mapNotNull { it as? String }
		val eventCountMatches = (cache["eventCount"] as? Number)?.toDouble() == eventCount.toDouble()
		if (cache["tipsHash"] == tipsHash && eventCountMatches) {
			val ok = rawOrder.size == eventCount && rawOrder.all { it is String && byId.containsKey(it) }
			if (ok) return cachedOrder
		}
		val cachedCount = (cache["eventCount"] as? Number)?.toDouble()
		if (cachedCount != null && cachedCount <= eventCount.toDouble() &&
			rawOrder.all { it is String && byId.containsKey(it) }
		) {
			val merged = mergeTopologicalOrder(cachedOrder, events)
			if (merged.size == eventCount) return merged
		}
	}

	return topologicalCanonicalOrder(eventsToMetas(events))
}

/**
 * 构造可写入 events.order.json 的缓存体。
 * @param order 拓扑序
 * @param events 全量事件
 * @return `{ order, tipsHash, eventCount }`
 */
fun buildOrderCachePayload(order: List<String>, events: List<Map<String, Any?>>): Map<String, Any?> {
	val tips = computeDagTipIdsFromEvents(events)
	return linkedMapOf(
		"order" to order,
		"tipsHash" to computeLocalTipsHash(tips),
		"eventCount" to events.size.toDouble(),
	)
}

/**
 * 读取拓扑序缓存；缺失或非法时返回 null（等价 JS `JSON.parse` 失败返回 null）。
 * @param path `events.order.json` 路径
 * @return 缓存或 null
 */
suspend fun readOrderCache(path: String): Map<String, Any?>? = withContext(Dispatchers.IO) {
	try {
		@Suppress("UNCHECKED_CAST")
		Json.parse(Files.readString(Paths.get(path), Charsets.UTF_8)) as? Map<String, Any?>
	}
	catch (_: Exception) {
		null
	}
}

/**
 * 写入拓扑序缓存。纯性能缓存：写失败（如群目录在并发清理/拆群时被删，Windows 上 open 报
 * EPERM、或 ENOENT/EBUSY）不应让物化抛错或上浮告警，静默忽略即可，下次读盘自会重建。
 * @param path 路径
 * @param payload 缓存体
 */
suspend fun writeOrderCache(path: String, payload: Map<String, Any?>): Unit = withContext(Dispatchers.IO) {
	try {
		Paths.get(path).parent?.let { Files.createDirectories(it) }
		Files.writeString(Paths.get(path), Json.stringify(payload) ?: "null", Charsets.UTF_8)
	}
	catch (_: Exception) {
		// best-effort cache: dir removed mid-teardown / transient FS error
	}
}

/**
 * 删除拓扑序缓存（缺失时静默忽略）。
 * @param path 路径
 */
suspend fun deleteOrderCache(path: String): Unit = withContext(Dispatchers.IO) {
	try {
		Files.deleteIfExists(Paths.get(path))
	}
	catch (_: Exception) {
		// absent
	}
}
