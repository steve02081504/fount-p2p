package io.github.steve02081504.fountp2p.mailbox

import io.github.steve02081504.fountp2p.wire.WireAdapter
import io.github.steve02081504.fountp2p.wire.WireContext
import io.github.steve02081504.fountp2p.wire.WireHandler
import io.github.steve02081504.fountp2p.wire.subscribeWire

/**
 * Mailbox wire 挂载。
 *
 * 等价 `js/mailbox/wire.mjs`。JS 直接调用 `deliver_or_store.mjs` 的 ingest/respond
 * 函数；但 `deliver_or_store.mjs` 依赖尚未移植的 `transport/`（已按计划延后），
 * 因此 Kotlin 侧把这三个入站动作抽象为 [MailboxWireHandlers]，由后续移植者注入实现。
 * 解析、action 注册与 `sendGive` 回调的构造与 JS 保持一致。
 */

/** mailbox 入站动作（由 `deliver_or_store` 移植后实现；JS 直接调用同名函数）。 */
interface MailboxWireHandlers {
	/**
	 * @param wireContext 入站上下文
	 * @param put 已解析的 mailbox_put 载荷
	 * @param peerId 对端 nodeHash
	 */
	fun ingestMailboxPut(wireContext: WireContext, put: Map<String, Any?>, peerId: String)

	/**
	 * @param want 已解析的 mailbox_want 载荷
	 * @param sendGive mailbox_give 发送回调
	 * @param peerId 请求方 peer
	 */
	fun respondMailboxWant(
		want: Map<String, Any?>,
		sendGive: (payload: Any?, peerId: String) -> Unit,
		peerId: String,
	)

	/**
	 * @param wireContext 入站上下文
	 * @param give 已解析的 mailbox_give 载荷
	 */
	fun ingestMailboxGive(wireContext: WireContext, give: Map<String, Any?>)
}

/**
 * @param wireContext 入站上下文
 * @param wire action 表
 * @param handlers mailbox 入站动作实现
 * @return 取消挂载的 dispose
 */
fun attachMailboxWire(
	wireContext: WireContext,
	wire: WireAdapter,
	handlers: MailboxWireHandlers,
): () -> Unit = subscribeWire(
	wire,
	linkedMapOf<String, WireHandler>(
		"mailbox_put" to { payload, peerId ->
			val put = parseMailboxPut(payload)
			if (put is MailboxParseResult.Ok) handlers.ingestMailboxPut(wireContext, put.value, peerId)
		},
		"mailbox_want" to { payload, peerId ->
			val want = parseMailboxWant(payload)
			if (want is MailboxParseResult.Ok)
				handlers.respondMailboxWant(
					want.value,
					{ giveWire, targetPeerId ->
						try {
							wire.send("mailbox_give", giveWire, targetPeerId)
						}
						catch (_: Throwable) {
							// disconnected
						}
					},
					peerId,
				)
		},
		"mailbox_give" to { payload, _ ->
			val give = parseMailboxGive(payload)
			if (give is MailboxParseResult.Ok) handlers.ingestMailboxGive(wireContext, give.value)
		},
	),
)
