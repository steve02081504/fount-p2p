package io.github.steve02081504.fountp2p.wire.part

import io.github.steve02081504.fountp2p.core.isPlainObject
import io.github.steve02081504.fountp2p.wire.WireAdapter
import io.github.steve02081504.fountp2p.wire.WireContext
import io.github.steve02081504.fountp2p.wire.WireHandler

/**
 * 群组房间内的 part wire（要求入站载荷带 `groupId`）。
 *
 * 等价 `js/wire/part/group.mjs`。
 */

/**
 * @param data part 载荷
 * @param groupId 群 ID
 * @return 校验通过后的载荷
 */
private fun parseGroupContext(data: Any?, groupId: String): Map<String, Any?>? {
	if (!isPlainObject(data)) return null
	val payload = data as Map<*, *>
	if (payload["groupId"] != groupId) return null
	@Suppress("UNCHECKED_CAST")
	return data as Map<String, Any?>
}

/**
 * @param wire 底层 wire
 * @param groupId 群 ID
 * @return 仅放行 `groupId` 的 `on` 适配
 */
private fun wrapWireOn(wire: WireAdapter, groupId: String): (String, WireHandler) -> (() -> Unit)? =
	{ name, handler ->
		wire.on(name) { data, peerId ->
			val payload = parseGroupContext(data, groupId)
			if (payload != null) handler(payload, peerId)
		}
	}

/**
 * 群组房间内挂载 part_wire（要求载荷带 `groupId`）。
 * @param wireContext 站点上下文
 * @param groupId 群 ID
 * @param wire action 层
 * @param options 站点选项
 * @return 取消订阅的 dispose
 */
fun attachGroupPartWire(
	wireContext: WireContext,
	groupId: String,
	wire: WireAdapter,
	options: PartWireOptions = PartWireOptions(),
): () -> Unit {
	val wrappedOn = wrapWireOn(wire, groupId)
	val scoped = object : WireAdapter {
		override fun on(name: String, handler: WireHandler): (() -> Unit)? = wrappedOn(name, handler)
		override fun send(name: String, payload: Any?, peerId: String?) = wire.send(name, payload, peerId)
	}
	return attachPartWire(wireContext, scoped, options)
}
