package io.github.steve02081504.fountp2p.wire

/**
 * wire 入站 handler：`(payload, peerId) => void`。
 *
 * 对应 `js/wire/adapter.mjs` 中 `WireAdapter.on` 的 handler 形态。
 */
typealias WireHandler = (payload: Any?, peerId: String) -> Unit

/**
 * 底层 wire 适配器（对应 `js/wire/adapter.mjs` 的 `WireAdapter` typedef）。
 *
 * [on] 可返回取消订阅函数或 null（JS typedef 允许 `void`）。
 */
interface WireAdapter {
	/**
	 * @param name action 名
	 * @param handler 入站回调
	 * @return 取消订阅函数（可为 null）
	 */
	fun on(name: String, handler: WireHandler): (() -> Unit)?

	/**
	 * @param name action 名
	 * @param payload 载荷
	 * @param peerId 目标 peer（broadcast 时为 null）
	 */
	fun send(name: String, payload: Any?, peerId: String?)
}

/**
 * 入站上下文（对应 `js/wire/adapter.mjs` 的 `WireContext` typedef）。
 */
interface WireContext {
	/** 副本用户名（trust graph 上下文）。 */
	val replicaUsername: String?
}

/** [WireContext] 的简单实现。 */
data class DefaultWireContext(override val replicaUsername: String? = null) : WireContext
