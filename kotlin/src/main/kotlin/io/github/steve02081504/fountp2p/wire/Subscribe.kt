package io.github.steve02081504.fountp2p.wire

/**
 * 批量注册 wire action，返回统一 dispose。
 *
 * 等价 `js/wire/subscribe.mjs`。JS 对每个 `wire.on` 返回值无条件调用；
 * 由于 JS typedef 允许 `on` 返回 `void`，此处对 null 跳过。
 * @param wire action 表
 * @param handlers action → handler（保持插入序）
 * @return 取消全部注册
 */
fun subscribeWire(wire: WireAdapter, handlers: Map<String, WireHandler>): () -> Unit {
	val disposers = handlers.map { (name, handler) -> wire.on(name, handler) }
	return {
		for (dispose in disposers) dispose?.invoke()
	}
}
