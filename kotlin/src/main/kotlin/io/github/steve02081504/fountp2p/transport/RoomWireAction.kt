package io.github.steve02081504.fountp2p.transport

/**
 * room wire action 绑定（等价 `js/transport/room_wire_action.mjs`）。
 */

/** room 的 action 发送/订阅表。 */
interface RoomWireActions {
	/**
	 * @param name action 名
	 * @return 发送函数 `(payload, peerId) => void`
	 */
	fun sender(name: String): (payload: Any?, peerId: String?) -> Unit

	/**
	 * @param name action 名
	 * @param handler 入站回调
	 */
	fun on(name: String, handler: (payload: Any?, peerId: String?) -> Unit)
}

/** room 上下文（含 wireActions 与 senderRegistry）。 */
class RoomContext(
	val wireActions: RoomWireActions,
	val senderRegistry: MutableMap<String, (payload: Any?, peerId: String?) -> Unit>,
)

/** 绑定结果：发送函数与注册回调。 */
class WiredAction(
	val send: (payload: Any?, peerId: String?) -> Unit,
	val on: (handler: (payload: Any?, peerId: String?) -> Unit) -> Unit,
)

/**
 * 将 room 的 wire action 绑定到 senderRegistry。
 * @param roomContext 房间上下文
 * @param name action 名称
 * @return 发送函数与注册回调
 */
fun wireAction(roomContext: RoomContext, name: String): WiredAction {
	val send = roomContext.wireActions.sender(name)
	roomContext.senderRegistry[name] = send
	return WiredAction(
		send = send,
		on = { handler -> roomContext.wireActions.on(name, handler) },
	)
}
