package io.github.steve02081504.fountp2p.link

import io.github.steve02081504.fountp2p.link.providers.RtcSignal
import io.github.steve02081504.fountp2p.link.providers.WebRtcLinkOptions
import io.github.steve02081504.fountp2p.link.providers.createWebRtcLink
import io.github.steve02081504.fountp2p.link.rtc.RtcPeerConnectionLike
import io.github.steve02081504.fountp2p.link.rtc.RtcProvider
import io.github.steve02081504.fountp2p.node.ICE_LOCAL_HOSTNAME_LADDER
import io.github.steve02081504.fountp2p.node.iceLocalHostnameLadder
import io.github.steve02081504.fountp2p.node.setSignalingRuntimeConfig
import io.github.steve02081504.fountp2p.node.withTempNode
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 等价 `js/test/pure/rtc_ice_ladder.test.mjs` 的确定性部分：
 * ICE 本地主机名策略按观测到的候选集逐级升级（fount-p2p#37 次要观察的通用化）。
 *
 * 发起方阶梯与「响应方按 offer 的 rung 重建并回 echo」的端到端时序由 JS 侧用例覆盖
 * （`js/test/pure/rtc_ice_ladder.test.mjs` 的两条 responder 用例）。
 */
class RtcIceLadderTest {
	/** 只有 `.local` host name 的候选：`drop` 会把它丢掉，`none` 会保留。 */
	private val localHostnameCandidate = "candidate:1 1 udp 2130706431 eden.local 54321 typ host"

	/**
	 * 假 RTCPeerConnection：本地描述一就绪就产出候选（模拟真实 gathering），
	 * 候选经库内策略过滤后计数。`close()` 也照真实后端做：把状态推到 `closed`、经
	 * [RtcPeerConnectionLike.onConnectionStateChange] 通知，之后拒绝再协商（fount-p2p#39）。
	 * @param candidateSdp 要派发的候选；null 表示这一级不产出候选
	 */
	private class FakePeerConnection(private val candidateSdp: String?) : RtcPeerConnectionLike {
		override var localDescription: Map<String, Any?>? = null
		override var remoteDescription: Map<String, Any?>? = null
		override val signalingState: String = "stable"
		override val iceGatheringState: String = "gathering"
		override var connectionState: String = "new"
		override val iceConnectionState: String = "new"
		override var onIceCandidate: ((Map<String, Any?>?) -> Unit)? = null
		override var onDataChannel: ((RtcDataChannel) -> Unit)? = null
		override var onConnectionStateChange: (() -> Unit)? = null

		/** `close()` 次数：被替换掉的那一级只该关一次。 */
		var closeCalls = 0

		/** `close()` 时是否还挂着状态回调；为 true 就意味着这次关闭会去关当前存活的那一级（fount-p2p#39）。 */
		var closedWithStateHandler = false

		override suspend fun createOffer(): Map<String, Any?> = linkedMapOf("type" to "offer", "sdp" to "v=0\r\n")

		override suspend fun createAnswer(): Map<String, Any?> = linkedMapOf("type" to "answer", "sdp" to "v=0\r\n")

		override suspend fun setLocalDescription(description: Map<String, Any?>) {
			// 与 node-datachannel 同一报错文本：已销毁的连接不能再协商。
			check(connectionState != "closed") { "setLocalDescription() called on destroyed peer connection" }
			localDescription = description
			val sdp = candidateSdp ?: return
			onIceCandidate?.invoke(linkedMapOf("candidate" to linkedMapOf("candidate" to sdp, "sdpMid" to "0")))
		}

		override suspend fun setRemoteDescription(description: Map<String, Any?>) {
			remoteDescription = description
		}

		override suspend fun addIceCandidate(candidate: Map<String, Any?>) { }

		override fun createDataChannel(label: String): RtcDataChannel = object : RtcDataChannel {
			override val label: String = label
			override val readyState: String = "open"
			override var bufferedAmount: Double = 0.0
			override var bufferedAmountLowThreshold: Double = 0.0
			override var onBufferedAmountLow: (() -> Unit)? = null
			override var onOpen: (() -> Unit)? = null
			override var onClose: (() -> Unit)? = null
			override var onMessage: ((Any?) -> Unit)? = null
			override fun send(bytes: ByteArray) { }
			override fun close() { }
		}

		override suspend fun close() {
			closeCalls++
			closedWithStateHandler = onConnectionStateChange != null
			connectionState = "closed"
			onConnectionStateChange?.invoke()
		}

		override fun localDescriptionSdp(): String = localDescription?.get("sdp") as? String ?: ""

		override fun remoteDescriptionSdp(): String = remoteDescription?.get("sdp") as? String ?: ""
	}

	/** 假 RTC 后端：每次 createPeerConnection 都返回一个会产出候选的新连接。 */
	private class FakeRtcProvider(private val candidateSdp: String?) : RtcProvider {
		override val backend: String = "fake"
		val connections = ArrayList<FakePeerConnection>()

		override fun createPeerConnection(config: Map<String, Any?>?): RtcPeerConnectionLike =
			FakePeerConnection(candidateSdp).also { connections.add(it) }
	}

	/**
	 * 建链结束时某个 pc 的关闭状态快照。
	 * 取快照的时机是「测试收尾关链之前」，所以它只反映阶梯自己关掉的连接。
	 * @property closeCalls `close()` 被调用的次数
	 * @property closedWithStateHandler `close()` 时是否还挂着状态回调（是的话这次关闭会连带去关存活的那一级）
	 */
	private class ConnectionCloseState(val closeCalls: Int, val closedWithStateHandler: Boolean)

	/**
	 * 一次发起方建链的结果。
	 * @property sent 出站信令
	 * @property closeStates 依次建过的 pc 的关闭状态快照（顺序即建链顺序）
	 */
	private class InitiatorRun(val sent: List<Map<String, Any?>>, val closeStates: List<ConnectionCloseState>)

	/**
	 * 跑一次发起方建链并收集出站信令。
	 * @param candidateSdp 每级 gathering 要产出的候选；null 表示不产出
	 * @param handshakeTimeoutMs 握手超时
	 * @return 出站信令与各 pc 的关闭状态快照
	 */
	private suspend fun runInitiator(
		candidateSdp: String?,
		handshakeTimeoutMs: Long = 5_000,
	): InitiatorRun {
		val rtc = FakeRtcProvider(candidateSdp)
		val sent = ArrayList<Map<String, Any?>>()
		val firstSend = CompletableDeferred<Unit>()
		val signal = object : RtcSignal {
			override suspend fun send(message: Map<String, Any?>) {
				sent.add(message)
				firstSend.complete(Unit)
			}

			override fun onRemote(handler: (Map<String, Any?>) -> Unit): () -> Unit = { }
		}
		val link = createWebRtcLink(
			WebRtcLinkOptions(
				nodeHash = "b".repeat(64),
				initiator = true,
				signal = signal,
				iceServers = emptyList(),
				handshakeTimeoutMs = handshakeTimeoutMs,
				rtc = rtc,
				// 阶梯测试不该依赖真实墙钟窗口（全量并发时会抖动）。
				iceCandidateSettleMs = 60,
				iceGatheringStallMs = 120,
			),
		)
		return try {
			withTimeoutOrNull(handshakeTimeoutMs) { firstSend.await() }
			InitiatorRun(sent.toList(), rtc.connections.map { ConnectionCloseState(it.closeCalls, it.closedWithStateHandler) })
		}
		finally {
			link.close("test-done")
		}
	}

	@Test
	fun `iceLocalHostnameLadder escalates from drop to none and honours an explicit start`() {
		assertEquals(listOf("drop", "none"), ICE_LOCAL_HOSTNAME_LADDER)
		assertEquals(listOf("drop", "none"), iceLocalHostnameLadder(null))
		assertEquals(listOf("drop", "none"), iceLocalHostnameLadder("drop"))
		assertEquals(listOf("none"), iceLocalHostnameLadder("none"))
		// 调试/同机策略不应自动放宽成对外候选。
		assertEquals(listOf("rewrite-loopback"), iceLocalHostnameLadder("rewrite-loopback"))
		// 未配置时从阶梯首项起。
		assertEquals("drop", ICE_LOCAL_HOSTNAME_LADDER.first())
	}

	@Test
	fun `initiator escalates to the next rung when a policy drains every local candidate`() = runBlocking {
		withTempNode("fount-p2p-ice-ladder-") {
			setSignalingRuntimeConfig(mapOf("channels" to mapOf("webrtc" to mapOf("iceLocalHostnamePolicy" to "drop"))))
			val run = runInitiator(localHostnameCandidate)
			val offers = run.sent.filter { it["type"] == "description" }
			assertEquals(1, offers.size)
			// 第 0 级 drop 丢掉唯一的 `.local` 候选 → 升到第 1 级再发。
			assertEquals(1.0, (offers[0]["rung"] as? Number)?.toDouble())
			// 首轮复用订阅信令前建好的第 0 级，换级时才建新 pc：整条阶梯只有两个 pc。
			assertEquals(2, run.closeStates.size)
			// 被换掉的一级要「先摘回调再关」：它只关过一次（自己），且关闭时已无状态回调，关闭波不到存活的那一级。
			assertEquals(1, run.closeStates[0].closeCalls)
			assertEquals(false, run.closeStates[0].closedWithStateHandler)
			// 存活的那一级阶梯自己没关过（快照取在测试收尾关链之前）。
			assertEquals(0, run.closeStates[1].closeCalls)
		}
	}

	@Test
	fun `initiator does not escalate when the first rung already produced candidates`() = runBlocking {
		withTempNode("fount-p2p-ice-ladder-") {
			setSignalingRuntimeConfig(mapOf("channels" to mapOf("webrtc" to mapOf("iceLocalHostnamePolicy" to "drop"))))
			// 普通 host 候选在 `drop` 下也保留，所以第 0 级即成交，不应再换级。
			val run = runInitiator("candidate:2 1 udp 2130706430 10.0.0.5 54322 typ host")
			val offers = run.sent.filter { it["type"] == "description" }
			assertEquals(1, offers.size)
			assertEquals(0.0, (offers[0]["rung"] as? Number)?.toDouble())
			// 第 0 级即成交：订阅信令前建的那一个 pc 就是最终这一级，不再重建（fount-p2p#39）。
			assertEquals(1, run.closeStates.size)
			assertEquals(0, run.closeStates[0].closeCalls)
		}
	}

	/** 建链前把句柄 `ready` 结算成的状态。 */
	private enum class ReadyState { SUCCEEDED, CANCELLED, FAILED }

	/**
	 * 失败信令装置：`send` 遇到 answer 时记录一次并抛错，模拟订阅已断的响应方。
	 */
	private class FailingAnswerSignal {
		var remoteHandler: ((Map<String, Any?>) -> Unit)? = null
		val answerSendAttempted = CompletableDeferred<Unit>()
		val signal = object : RtcSignal {
			override suspend fun send(message: Map<String, Any?>) {
				if ((message["description"] as? Map<*, *>)?.get("type") != "answer") return
				answerSendAttempted.complete(Unit)
				throw IllegalStateException("signal unavailable")
			}

			override fun onRemote(handler: (Map<String, Any?>) -> Unit): () -> Unit {
				remoteHandler = handler
				return { remoteHandler = null }
			}
		}

		/** @param rung offer 的级号 */
		fun deliverOffer(rung: Int) {
			remoteHandler?.invoke(
				linkedMapOf("type" to "description", "rung" to rung.toDouble(), "description" to mapOf("type" to "offer", "sdp" to "v=0\r\n")),
			)
		}
	}

	/**
	 * 跑一次「答复信令发不出去」的响应方建链：answer 发送已发生，随后信令层抛错。
	 * @param ready 建链前把句柄的 ready 结算成什么状态；null 表示保持未结算
	 * @return 该链路是否被拆掉（建链失败路径会关掉底层 peer connection）
	 */
	private suspend fun runFailedAnswerSignal(ready: ReadyState?): Boolean {
		var tornDown = false
		withTempNode("fount-p2p-webrtc-answer-signal-") {
			val rtc = FakeRtcProvider("candidate:2 1 udp 2130706430 10.0.0.5 54322 typ host")
			val failing = FailingAnswerSignal()
			val link = createWebRtcLink(WebRtcLinkOptions(signal = failing.signal, rtc = rtc, iceServers = emptyList(), iceCandidateSettleMs = 5, iceGatheringStallMs = 20))
			try {
				val connection = rtc.connections.single()
				when (ready) {
					ReadyState.SUCCEEDED -> assertEquals(true, link.ready.complete(Unit))
					ReadyState.CANCELLED -> link.ready.cancel()
					ReadyState.FAILED -> link.ready.completeExceptionally(IllegalStateException("p2p: link closed before ready"))
					null -> Unit
				}
				failing.deliverOffer(0)
				withTimeout(1_000) { failing.answerSendAttempted.await() }
				// 关闭是 fire-and-forget 的：等它一整个建链窗口，等到就说明被拆了。
				tornDown = withTimeoutOrNull(500) { while (connection.connectionState != "closed") delay(5) } != null
			}
			finally {
				link.close("test-done")
			}
		}
		return tornDown
	}

	@Test
	fun `failed renegotiation signal leaves a ready link open`() = runBlocking {
		assertEquals(false, runFailedAnswerSignal(ReadyState.SUCCEEDED))
	}

	@Test
	fun `failed renegotiation signal does not treat a cancelled ready as ready`() = runBlocking {
		assertEquals(true, runFailedAnswerSignal(ReadyState.CANCELLED))
	}

	@Test
	fun `failed renegotiation signal does not treat a failed ready as ready`() = runBlocking {
		assertEquals(true, runFailedAnswerSignal(ReadyState.FAILED))
	}

	@Test
	fun `failed answer signal still closes a link before ready`() = runBlocking {
		assertEquals(true, runFailedAnswerSignal(null))
	}
}
