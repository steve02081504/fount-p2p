package io.github.steve02081504.fountp2p.dag

import io.github.steve02081504.fountp2p.core.HEX_ID_64
import io.github.steve02081504.fountp2p.core.JsonUndefined
import io.github.steve02081504.fountp2p.core.canonicalStringify
import io.github.steve02081504.fountp2p.crypto.sha256
import io.github.steve02081504.fountp2p.crypto.sha256Hex
import java.util.PriorityQueue

/** 64 位十六进制事件 ID 正则别名。 */
val EVENT_ID_HEX = HEX_ID_64

/**
 * 对事件 id 列表做二叉 Merkle 根（字典序叶子，§7 checkpoint）。
 * @param ids 事件 id
 * @return 64 位十六进制根
 */
fun merkleRoot(ids: List<String>): String {
	val sorted = ids.filter { EVENT_ID_HEX.matches(it) }.toSortedSet().toList()
	if (sorted.isEmpty()) return sha256Hex("")
	var level = sorted.map { sha256(it) }
	while (level.size > 1) {
		val next = ArrayList<ByteArray>((level.size + 1) / 2)
		var index = 0
		while (index < level.size) {
			val left = level[index]
			val right = if (index + 1 < level.size) level[index + 1] else left
			next.add(sha256(left + right))
			index += 2
		}
		level = next
	}
	return io.github.steve02081504.fountp2p.core.bytesToHex(level[0])
}

/**
 * 本节点可见 DAG 叶集合摘要（§7.1 `local_tips_hash`）。
 * @param tipIds 叶事件 id
 * @return SHA-256 十六进制
 */
fun computeLocalTipsHash(tipIds: List<String>): String {
	val sorted = tipIds.filter { EVENT_ID_HEX.matches(it) }.toSortedSet().toList()
	return sha256Hex(sorted.joinToString(","))
}

/**
 * 规范化父 id 列表：去重、去空、字典序（§6 验签域）。
 * @param raw 原始 prev_event_ids 字段
 * @return 去重并字典序排序后的父事件 id 数组
 */
fun sortedPrevEventIds(raw: Any?): List<String> {
	val list = raw as? List<*> ?: return emptyList()
	return list.filterIsInstance<String>().filter { EVENT_ID_HEX.matches(it) }.toSortedSet().toList()
}

/** 移除对象中值为 `undefined` 的键（浅拷贝）。 */
private fun stripUndefined(map: Map<String, Any?>): Map<String, Any?> {
	val out = LinkedHashMap<String, Any?>()
	for ((key, value) in map) if (value !== JsonUndefined) out[key] = value
	return out
}

/**
 * 从事件中取出参与 ID 计算与签名的字段（不含 id、signature、received_at 等）。
 * @param event 完整事件对象
 * @return 用于 canonical 序列化与验签的正文子集
 */
fun eventBodyForSign(event: Map<String, Any?>): Map<String, Any?> {
	val body = LinkedHashMap<String, Any?>()
	body["type"] = event["type"]
	body["groupId"] = event["groupId"]
	body["channelId"] = event["channelId"] ?: null
	body["sender"] = event["sender"]
	body["charId"] = event["charId"] ?: null
	body["timestamp"] = event["timestamp"]
	body["hlc"] = event["hlc"]
	body["prev_event_ids"] = sortedPrevEventIds(event["prev_event_ids"])
	body["content"] = event["content"]
	if (event["node_id"] != null) body["node_id"] = event["node_id"]
	return stripUndefined(body)
}

/**
 * 事件 ID = SHA256(canonical unsigned body) 十六进制。
 * @param body `eventBodyForSign` 或同形对象
 * @return SHA256 十六进制事件 id
 */
fun computeEventId(body: Map<String, Any?>): String {
	val normalized = LinkedHashMap(body)
	if (normalized.containsKey("prev_event_ids"))
		normalized["prev_event_ids"] = sortedPrevEventIds(normalized["prev_event_ids"])
	return sha256Hex(canonicalStringify(stripUndefined(normalized)))
}

/**
 * 验签 / 哈希用的 UTF-8 字节序列。
 * @param body 与 `computeEventId` 同形的正文对象
 * @return canonical JSON 的 UTF-8 字节
 */
fun signPayloadBytes(body: Map<String, Any?>): ByteArray {
	val normalized = LinkedHashMap(body)
	normalized["prev_event_ids"] = sortedPrevEventIds(body["prev_event_ids"])
	return canonicalStringify(stripUndefined(normalized)).toByteArray(Charsets.UTF_8)
}

/**
 * 规范拓扑序（Kahn + tiebreaker：hlc.wall, hlc.logical, node_id, id）。
 * @param metas 事件元数据列表
 * @return 按规范顺序排列的事件 id 列表
 */
fun topologicalCanonicalOrder(metas: List<Map<String, Any?>>): List<String> {
	if (metas.isEmpty()) return emptyList()
	val byId = HashMap<String, Map<String, Any?>>()
	for (meta in metas) {
		val id = meta["id"] as? String ?: continue
		byId[id] = meta
	}
	val parentCount = HashMap<String, Int>()
	val children = HashMap<String, MutableList<String>>()
	for (meta in metas) {
		val id = meta["id"] as? String ?: continue
		val parentsInGraph = sortedPrevEventIds(meta["prev_event_ids"]).filter { byId.containsKey(it) }
		parentCount[id] = parentsInGraph.size
		for (parentId in parentsInGraph) children.getOrPut(parentId) { mutableListOf() }.add(id)
	}

	fun hlcOf(eventId: String): Pair<Long, Long> {
		val hlc = byId[eventId]?.get("hlc") as? Map<*, *>
		val wall = (hlc?.get("wall") as? Number)?.toLong() ?: 0L
		val logical = (hlc?.get("logical") as? Number)?.toLong() ?: 0L
		return wall to logical
	}

	val compareIds = Comparator<String> { leftId, rightId ->
		val (leftWall, leftLogical) = hlcOf(leftId)
		val (rightWall, rightLogical) = hlcOf(rightId)
		when {
			leftWall != rightWall -> leftWall.compareTo(rightWall)
			leftLogical != rightLogical -> leftLogical.compareTo(rightLogical)
			else -> {
				val leftNode = byId[leftId]?.get("node_id")?.toString() ?: ""
				val rightNode = byId[rightId]?.get("node_id")?.toString() ?: ""
				if (leftNode != rightNode) leftNode.compareTo(rightNode) else leftId.compareTo(rightId)
			}
		}
	}

	val ordered = ArrayList<String>(metas.size)
	val ready = PriorityQueue(compareIds)
	for (meta in metas) {
		val id = meta["id"] as? String ?: continue
		if (parentCount[id] == 0) ready.add(id)
	}

	while (ready.isNotEmpty()) {
		val next = ready.poll()
		ordered.add(next)
		for (childId in children[next].orEmpty()) {
			val remaining = (parentCount[childId] ?: 0) - 1
			parentCount[childId] = remaining
			if (remaining == 0) ready.add(childId)
		}
	}

	return ordered
}

/**
 * @param events DAG 事件行
 * @return 拓扑 meta 列表
 */
fun eventsToMetas(events: List<Map<String, Any?>>): List<Map<String, Any?>> = events.map { event ->
	mapOf(
		"id" to event["id"],
		"prev_event_ids" to event["prev_event_ids"],
		"hlc" to event["hlc"],
		"node_id" to event["node_id"],
		"sender" to event["sender"],
	)
}
