package io.github.steve02081504.fountp2p.schemas

import io.github.steve02081504.fountp2p.core.assertHex64

/**
 * 远程入站事件形状校验（仅 federation / P2P 路径调用）。
 * @param event DAG 事件
 */
fun validateRemoteEventShape(event: Map<String, Any?>?) {
	if (event == null) throw IllegalArgumentException("remote event: type required")
	val type = event["type"]
	if (type !is String || type.isEmpty()) throw IllegalArgumentException("remote event: type required")
	assertHex64(event["id"], "remote event.id")
	val prev = event["prev_event_ids"]
	if (prev !is List<*>) throw IllegalArgumentException("remote event: prev_event_ids must be array")
	for (parentId in prev) assertHex64(parentId, "remote event.prev_event_id")
	assertHex64(event["sender"], "remote event.sender")
}
