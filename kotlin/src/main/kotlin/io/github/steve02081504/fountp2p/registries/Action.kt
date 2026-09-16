package io.github.steve02081504.fountp2p.registries

/**
 * 基于 `room.makeAction(name)` 的通用 action 注册表
 * （`registries/action.mjs` 的等价实现）。
 */

/** action 发送函数。 */
fun interface ActionSend {
	/**
	 * @param payload 载荷
	 * @param peerId 目标 peer；null 表示广播
	 */
	fun send(payload: Any?, peerId: String?)
}

/** action 接收注册函数。 */
fun interface ActionGet {
	/** @param handler 入站回调 */
	fun register(handler: (payload: Any?, peerId: String?) -> Unit)
}

/** 提供 `makeAction(name)` 的房间对象。 */
fun interface ActionRoom {
	/** @param name action 名称 @return send 与 get 函数对 */
	fun makeAction(name: String): Pair<ActionSend, ActionGet>
}

/** P2P 房间 action 注册表，封装 makeAction 的 send/receive 对。 */
class ActionRegistry(val room: ActionRoom) {
	private val entries = HashMap<String, Pair<ActionSend, ActionGet>>()

	/**
	 * 预注册一个 action 名称。
	 * @param names action 名称
	 * @return 当前实例（链式调用）
	 */
	fun register(names: String): ActionRegistry {
		ensureEntry(names)
		return this
	}

	/**
	 * 预注册多个 action 名称。
	 * @param names action 名称列表
	 * @return 当前实例（链式调用）
	 */
	fun register(names: List<String>): ActionRegistry {
		for (name in names) ensureEntry(name)
		return this
	}

	/** 获取或创建指定 action 的 send/get 条目。 */
	private fun ensureEntry(name: String): Pair<ActionSend, ActionGet> =
		entries.getOrPut(name) { room.makeAction(name) }

	/**
	 * @param name action 名称
	 * @return 发送函数
	 */
	fun sender(name: String): ActionSend = ensureEntry(name).first

	/**
	 * @param name action 名称
	 * @return 接收注册函数
	 */
	fun receiver(name: String): ActionGet = ensureEntry(name).second

	/**
	 * 向指定 peer 发送 action 载荷。
	 * @param name action 名称
	 * @param payload 载荷
	 * @param peerId 目标 peer；null 表示广播
	 */
	fun send(name: String, payload: Any?, peerId: String? = null) {
		sender(name).send(payload, peerId)
	}

	/**
	 * 注册 action 入站 handler。
	 * @param name action 名称
	 * @param handler 入站回调
	 * @return 当前实例（链式调用）
	 */
	fun on(name: String, handler: (payload: Any?, peerId: String?) -> Unit): ActionRegistry {
		receiver(name).register(handler)
		return this
	}
}

/**
 * @param room 提供 makeAction 的房间对象
 * @return 新注册表
 */
fun createActionRegistry(room: ActionRoom): ActionRegistry = ActionRegistry(room)
