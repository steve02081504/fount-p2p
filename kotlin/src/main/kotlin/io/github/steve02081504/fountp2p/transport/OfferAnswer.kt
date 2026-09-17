package io.github.steve02081504.fountp2p.transport

import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.crypto.randomBytes
import io.github.steve02081504.fountp2p.discovery.decryptNodeSignalPacket
import io.github.steve02081504.fountp2p.discovery.sendNodeSignalPacket
import io.github.steve02081504.fountp2p.link.providers.LinkHandle
import io.github.steve02081504.fountp2p.link.providers.LinkProvider
import io.github.steve02081504.fountp2p.link.providers.RtcSignal
import io.github.steve02081504.fountp2p.link.providers.listLinkProviders
import io.github.steve02081504.fountp2p.link.providers.nostr.NostrLinkProvider
import io.github.steve02081504.fountp2p.node.nodeDebug
import io.github.steve02081504.fountp2p.node.shortHash
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * offer/answer 信令与 WebRTC 拨号（等价 `js/transport/offer_answer.mjs`）。
 *
 * 偏离：
 * - JS 的 `signalSessions` 值是 `createBufferedSignalSession` 返回对象；Kotlin 用
 *   [BufferedSignalSession]。信令消息在 JS 中是无类型 `unknown`，Kotlin 侧保留 [Any?]，
 *   仅在交给 WebRTC provider 时经 [BufferedSignalSession.asRtcSignal] 适配为 `RtcSignal`。
 * - `randomBytes(16).toString('hex')` 等价 [bytesToHex] + [randomBytes]。
 */

/** accept/dial 挂起期间 ICE 信令 backlog 上限。 */
const val SIGNAL_BACKLOG_MAX: Int = 64

/** 并发信令会话上限（按插入序淘汰最旧）。 */
val MAX_SIGNAL_SESSIONS: Int =
	maxOf(1, (loadTransportTunables()["maxSignalSessions"] as? Number)?.toDouble()?.toInt() ?: 256)

private val offerAnswerScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

/**
 * 入站 offer 可被攻击者用任意 connId 无上限创建会话；建新会话前淘汰到低于上限。
 * @param sessions 信令会话表
 * @param maxSize 上限
 */
fun ensureSignalSessionBudget(
	sessions: MutableMap<String, BufferedSignalSession>,
	maxSize: Any?,
) {
	val raw = (maxSize as? Number)?.toDouble()
	val cap = maxOf(1, if (raw == null || raw.isNaN()) 1 else raw.toInt())
	while (sessions.size >= cap) {
		val oldest = sessions.keys.firstOrNull() ?: return
		sessions[oldest]?.clear()
		sessions.remove(oldest)
	}
}

/**
 * 缓冲信令会话（等价 JS `createBufferedSignalSession`）。
 * @param sendRemote 远端发送回调
 */
class BufferedSignalSession(private val sendRemote: suspend (Any?) -> Unit) {
	private val handlers = LinkedHashSet<(Any?) -> Unit>()
	private val backlog = ArrayList<Any?>()

	/**
	 * @param message 待发送信令消息
	 */
	suspend fun send(message: Any?) {
		sendRemote(message)
	}

	/**
	 * @param handler 远端消息回调
	 * @return 取消订阅
	 */
	fun onRemote(handler: (Any?) -> Unit): () -> Unit {
		handlers.add(handler)
		val pending = ArrayList(backlog)
		backlog.clear()
		for (message in pending) handler(message)
		return { handlers.remove(handler); Unit }
	}

	/**
	 * @param message 入站信令消息
	 */
	fun deliver(message: Any?) {
		if (handlers.isEmpty()) {
			if (backlog.size >= SIGNAL_BACKLOG_MAX) backlog.removeAt(0)
			backlog.add(message)
			return
		}
		for (handler in handlers.toList()) handler(message)
	}

	/** 清空积压消息。 */
	fun clear() {
		backlog.clear()
		handlers.clear()
	}

	/** 适配 WebRTC provider 的 `RtcSignal`。 */
	fun asRtcSignal(): RtcSignal = object : RtcSignal {
		override suspend fun send(message: Map<String, Any?>) {
			this@BufferedSignalSession.send(message)
		}

		override fun onRemote(handler: (Map<String, Any?>) -> Unit): () -> Unit =
			this@BufferedSignalSession.onRemote { message ->
				@Suppress("UNCHECKED_CAST")
				handler((message as? Map<String, Any?>) ?: emptyMap())
			}
	}
}

/**
 * @param body 信令 body
 * @return 是否为 WebRTC offer description
 */
private fun isOfferSignalBody(body: Any?): Boolean {
	val map = body as? Map<*, *> ?: return false
	if (map["type"] != "description") return false
	val description = map["description"] as? Map<*, *> ?: return false
	return description["type"] == "offer"
}

/**
 * @return 首个需要 offer/answer 的 provider
 */
fun findOfferAnswerProvider(): LinkProvider? =
	listLinkProviders().firstOrNull { it.caps?.get("needsOfferAnswer") == true }

/** [createOfferAnswerDial] 依赖。 */
class OfferAnswerDialDeps(
	val localIdentity: Map<String, Any?>,
	val iceServers: () -> List<Any?>?,
	val signalSessions: MutableMap<String, BufferedSignalSession>,
	val registerResolvedLink: suspend (remoteNodeHash: String, link: LinkHandle) -> Unit,
	val trimToBudget: suspend () -> Unit,
	val getCanonicalLink: (remoteNodeHash: String) -> LinkHandle?,
)

/**
 * offer/answer 拨号器。
 * @param handleIncomingSignal 入站加密信令处理
 * @param handleSignalPacket 入站已解密信令处理
 * @param dialOfferAnswer 主动拨号
 */
class OfferAnswerDial(
	val handleIncomingSignal: suspend (ByteArray) -> Unit,
	val handleSignalPacket: suspend (Map<String, Any?>) -> Unit,
	val dialOfferAnswer: suspend (provider: LinkProvider, remoteNodeHash: String) -> LinkHandle?,
)

/**
 * @param deps 依赖
 * @return offer/answer 拨号
 */
fun createOfferAnswerDial(deps: OfferAnswerDialDeps): OfferAnswerDial {
	val localIdentity = deps.localIdentity
	val selfNodeHash = localIdentity["nodeHash"]?.toString() ?: ""

	/**
	 * @param remoteNodeHash 远端
	 * @param connId 连接 id
	 * @return 该连接的缓冲信令会话
	 */
	fun createConnSession(remoteNodeHash: String, connId: String): BufferedSignalSession =
		BufferedSignalSession { message ->
			sendNodeSignalPacket(
				remoteNodeHash,
				linkedMapOf(
					"type" to "signal",
					"from" to selfNodeHash,
					"connId" to connId,
					"body" to message,
				),
			)
		}

	/**
	 * @param provider 链路提供者
	 * @param remoteNodeHash 远端 nodeHash
	 * @param connId 连接 id
	 * @param session 信令会话
	 * @param initiator 是否主动拨号
	 * @return 建链成功返回规范链路，否则 null
	 */
	suspend fun buildConnLink(
		provider: LinkProvider,
		remoteNodeHash: String,
		connId: String,
		session: BufferedSignalSession,
		initiator: Boolean,
	): LinkHandle? = try {
		// 被动 accept 同样受活跃链路预算约束。
		deps.trimToBudget()
		val options = linkedMapOf<String, Any?>(
			"nodeHash" to remoteNodeHash,
			"signal" to session.asRtcSignal(),
			"iceServers" to deps.iceServers(),
			"localIdentity" to localIdentity,
		)
		val link = if (initiator) provider.dial(options) else provider.accept(options)
		if (link == null) {
			deps.signalSessions.remove(connId)
			nodeDebug(
				"p2p:webrtc null",
				linkedMapOf(
					"peer" to shortHash(remoteNodeHash),
					"provider" to provider.id,
					"role" to if (initiator) "dial" else "accept",
				),
			)
			null
		}
		else {
			link.onDown { deps.signalSessions.remove(connId); Unit }
			link.ready.await()
			deps.registerResolvedLink(remoteNodeHash, link)
			deps.getCanonicalLink(remoteNodeHash)
		}
	}
	catch (error: Exception) {
		deps.signalSessions.remove(connId)
		nodeDebug(
			"p2p:webrtc fail",
			linkedMapOf(
				"peer" to shortHash(remoteNodeHash),
				"provider" to provider.id,
				"role" to if (initiator) "dial" else "accept",
				"err" to (error.message ?: error.toString()),
			),
		)
		null
	}

	/**
	 * @param packet 已解密的 signal 包
	 */
	suspend fun handleSignalPacket(packet: Map<String, Any?>) {
		if (packet["type"] != "signal") return
		val remoteNodeHash = isHex64(packet["from"]) ?: return
		val connId = packet["connId"]?.toString() ?: ""
		if (remoteNodeHash == selfNodeHash || connId.isEmpty()) return
		var session = deps.signalSessions[connId]
		if (session == null) {
			if (!isOfferSignalBody(packet["body"])) return
			val provider = findOfferAnswerProvider() ?: return
			nodeDebug(
				"p2p:webrtc inbound offer",
				linkedMapOf("peer" to shortHash(remoteNodeHash), "provider" to provider.id),
			)
			ensureSignalSessionBudget(deps.signalSessions, MAX_SIGNAL_SESSIONS)
			val created = createConnSession(remoteNodeHash, connId)
			deps.signalSessions[connId] = created
			offerAnswerScope.launch {
				buildConnLink(provider, remoteNodeHash, connId, created, initiator = false)
			}
			session = created
		}
		session.deliver(packet["body"])
	}

	/**
	 * @param bytes 加密信令
	 */
	suspend fun handleIncomingSignal(bytes: ByteArray) {
		val packet = decryptNodeSignalPacket(selfNodeHash, bytes) ?: return
		if (packet["type"] == "link") {
			val provider = listLinkProviders().firstOrNull { it.id == "nostr" }
			(provider as? NostrLinkProvider)?.deliverPacket(packet)
			return
		}
		handleSignalPacket(packet)
	}

	/**
	 * @param provider 链路提供者
	 * @param remoteNodeHash 远端 nodeHash
	 * @return 建链成功返回规范链路，否则 null
	 */
	suspend fun dialOfferAnswer(provider: LinkProvider, remoteNodeHash: String): LinkHandle? {
		val connId = bytesToHex(randomBytes(16))
		val session = createConnSession(remoteNodeHash, connId)
		ensureSignalSessionBudget(deps.signalSessions, MAX_SIGNAL_SESSIONS)
		deps.signalSessions[connId] = session
		return buildConnLink(provider, remoteNodeHash, connId, session, initiator = true)
	}

	return OfferAnswerDial(
		handleIncomingSignal = ::handleIncomingSignal,
		handleSignalPacket = ::handleSignalPacket,
		dialOfferAnswer = ::dialOfferAnswer,
	)
}
