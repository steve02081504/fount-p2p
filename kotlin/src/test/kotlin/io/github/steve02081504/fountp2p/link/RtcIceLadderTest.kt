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
import kotlinx.coroutines.runBlocking
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
	 * 候选经库内策略过滤后计数。
	 * @param candidateSdp 要派发的候选；null 表示这一级不产出候选
	 */
	private class FakePeerConnection(private val candidateSdp: String?) : RtcPeerConnectionLike {
		override var localDescription: Map<String, Any?>? = null
		override var remoteDescription: Map<String, Any?>? = null
		override val signalingState: String = "stable"
		override val iceGatheringState: String = "gathering"
		override val connectionState: String = "new"
		override val iceConnectionState: String = "new"
		override var onIceCandidate: ((Map<String, Any?>?) -> Unit)? = null
		override var onDataChannel: ((RtcDataChannel) -> Unit)? = null
		override var onConnectionStateChange: (() -> Unit)? = null

		override suspend fun createOffer(): Map<String, Any?> = linkedMapOf("type" to "offer", "sdp" to "v=0\r\n")

		override suspend fun createAnswer(): Map<String, Any?> = linkedMapOf("type" to "answer", "sdp" to "v=0\r\n")

		override suspend fun setLocalDescription(description: Map<String, Any?>) {
			localDescription = description
			val sdp = candidateSdp ?: return
			onIceCandidate?.invoke(linkedMapOf("candidate" to linkedMapOf("candidate" to sdp, "sdpMid" to "0")))
		}

		override suspend fun setRemoteDescription(description: Map<String, Any?>) {
			remoteDescription = description
		}

		override suspend fun addIceCandidate(candidate: Map<String, Any?>) { }

		override fun createDataChannel(label: String): RtcDataChannel =
			object : RtcDataChannel {
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

		override suspend fun close() { }

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
	 * 跑一次发起方建链并收集出站信令。
	 * @param candidateSdp 每级 gathering 要产出的候选；null 表示不产出
	 * @param handshakeTimeoutMs 握手超时
	 * @return 出站信令列表与建过的 pc 数
	 */
	private suspend fun runInitiator(
		candidateSdp: String?,
		handshakeTimeoutMs: Long = 5_000,
	): Pair<List<Map<String, Any?>>, Int> {
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
			sent.toList() to rtc.connections.size
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
			val (sent, connectionCount) = runInitiator(localHostnameCandidate)
			val offers = sent.filter { it["type"] == "description" }
			assertEquals(1, offers.size)
			// 第 0 级 drop 丢掉唯一的 `.local` 候选 → 升到第 1 级再发。
			assertEquals(1.0, (offers[0]["rung"] as? Number)?.toDouble())
			// 至少建过两级 pc（初始一次 + 每级各一次）。
			assertEquals(true, connectionCount >= 3)
		}
	}

	@Test
	fun `initiator does not escalate when the first rung already produced candidates`() = runBlocking {
		withTempNode("fount-p2p-ice-ladder-") {
			setSignalingRuntimeConfig(mapOf("channels" to mapOf("webrtc" to mapOf("iceLocalHostnamePolicy" to "drop"))))
			// 普通 host 候选在 `drop` 下也保留，所以第 0 级即成交，不应再换级。
			val (sent, connectionCount) = runInitiator("candidate:2 1 udp 2130706430 10.0.0.5 54322 typ host")
			val offers = sent.filter { it["type"] == "description" }
			assertEquals(1, offers.size)
			assertEquals(0.0, (offers[0]["rung"] as? Number)?.toDouble())
			// 初始一次 + 第 0 级一次：没有换级。
			assertEquals(2, connectionCount)
		}
	}
}
