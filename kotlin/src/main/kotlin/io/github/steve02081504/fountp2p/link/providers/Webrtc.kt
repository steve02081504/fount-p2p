package io.github.steve02081504.fountp2p.link.providers

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.toBytes
import io.github.steve02081504.fountp2p.link.CHANNEL_BULK
import io.github.steve02081504.fountp2p.link.CHANNEL_CONTROL
import io.github.steve02081504.fountp2p.link.CHANNEL_LOW_THRESHOLD_BYTES
import io.github.steve02081504.fountp2p.link.ChannelSendQueues
import io.github.steve02081504.fountp2p.link.LinkPipe
import io.github.steve02081504.fountp2p.link.LinkPipeOptions
import io.github.steve02081504.fountp2p.link.RtcDataChannel
import io.github.steve02081504.fountp2p.link.asLinkHandle
import io.github.steve02081504.fountp2p.link.configureBufferedAmountLowThreshold
import io.github.steve02081504.fountp2p.link.createChannelSendQueues
import io.github.steve02081504.fountp2p.link.onBufferedAmountLow
import io.github.steve02081504.fountp2p.link.rtc.IceLocalHostnamePolicy
import io.github.steve02081504.fountp2p.link.rtc.RtcIceCandidate
import io.github.steve02081504.fountp2p.link.rtc.RtcPeerConnectionLike
import io.github.steve02081504.fountp2p.link.rtc.RtcProvider
import io.github.steve02081504.fountp2p.link.rtc.canUseWebRtcLink
import io.github.steve02081504.fountp2p.link.rtc.filterIceLocalHostnameCandidate
import io.github.steve02081504.fountp2p.link.rtc.loadNodeRtcPolyfill
import io.github.steve02081504.fountp2p.link.rtc.waitForChannelState
import io.github.steve02081504.fountp2p.link.extractDtlsFingerprint
import io.github.steve02081504.fountp2p.node.getSignalingRuntimeConfig
import io.github.steve02081504.fountp2p.node.iceLocalHostnameLadder
import io.github.steve02081504.fountp2p.node.nodeDebug
import io.github.steve02081504.fountp2p.utils.LruMap
import io.github.steve02081504.fountp2p.utils.ms
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** WebRTC 信令收发抽象。 */
interface RtcSignal {
	/**
	 * @param message 信令载荷
	 */
	suspend fun send(message: Map<String, Any?>)

	/**
	 * @param handler 入站信令回调
	 * @return 取消订阅
	 */
	fun onRemote(handler: (Map<String, Any?>) -> Unit): () -> Unit
}

/** `createWebRtcLink` 配置。 */
class WebRtcLinkOptions(
	val nodeHash: String? = null,
	val initiator: Boolean = false,
	val signal: RtcSignal,
	val iceServers: List<Any?>? = null,
	val heartbeatMs: Long? = null,
	val idleTimeoutMs: Long? = null,
	val handshakeTimeoutMs: Long? = null,
	val rtc: RtcProvider? = null,
	val localIdentity: Map<String, Any?>? = null,
	/** 候选收齐窗口覆盖（测试注入；默认 [ICE_CANDIDATE_SETTLE_MS]）。 */
	val iceCandidateSettleMs: Long? = null,
	/** gathering 停滞窗口覆盖（测试注入；默认 [ICE_GATHERING_STALL_MS]）。 */
	val iceGatheringStallMs: Long? = null,
)

private fun formatErrorReason(error: Any?): String {
	val message = when (error) {
		is Throwable -> error.message ?: error.toString()
		null -> "unknown-error"
		else -> error.toString()
	}
	return message.replace(Regex("\\s+"), " ").take(240)
}

/** 收到候选后多久无新候选就视为 gathering 收齐（polyfill 不推 complete 时的兜底）。 */
const val ICE_CANDIDATE_SETTLE_MS = 300L

/** gathering 状态轮询间隔。 */
private const val ICE_GATHERING_POLL_MS = 50L

/** 一个候选都没收到时，等这么久就放行让 DTLS/数据通道自行判成败。 */
val ICE_GATHERING_STALL_MS: Long = ms("3s")

/** [collectIceGathering] 的观测、超时与窗口配置。 */
class IceGatheringOptions(
	val iceGatheringState: () -> String,
	val handshakeTimeoutMs: Long,
	/** 当前一级收到的可用候选数（`drop` 策略下 `.local` 候选不计入）。 */
	val candidateCount: (() -> Int)? = null,
	/** gathering 停滞时回调（只报本次实际等了多久，其余诊断信息由调用方自己补）。 */
	val onStall: ((elapsedMs: Long) -> Unit)? = null,
	/** 候选收齐窗口；默认 [ICE_CANDIDATE_SETTLE_MS]。 */
	val settleMs: Long = ICE_CANDIDATE_SETTLE_MS,
	/** gathering 停滞窗口；默认 [ICE_GATHERING_STALL_MS]。 */
	val stallMs: Long = ICE_GATHERING_STALL_MS,
)

/**
 * 无 trickle ICE 时等本地候选收齐。
 *
 * 不把 `iceGatheringState == "complete"` 当作唯一完成条件：服务端 polyfill 在「全部 relay 超时」等
 * 情况下会让状态长期停在 "gathering"，于是等待永远到不了终点（fount-p2p#37 次要观察）。完成判据是：
 * 状态 complete、收到过候选且一段时间内再无新候选、或一个候选都没收到时直接放行。最后一种走
 * [ICE_GATHERING_STALL_MS]，让 DTLS/数据通道自己判成败，而不是在握手超时后才硬失败。
 * @param options 观测、超时与窗口配置
 * @return 结束原因：`complete` / `stable` / `stalled`
 * @throws IllegalStateException 超过 handshakeTimeoutMs 仍未收齐
 */
suspend fun collectIceGathering(options: IceGatheringOptions): String {
	val startedAt = System.currentTimeMillis()
	val deadline = startedAt + options.handshakeTimeoutMs
	fun failIfOverdue() {
		if (System.currentTimeMillis() >= deadline)
			throw IllegalStateException("p2p: ice gathering incomplete after ${options.handshakeTimeoutMs}ms")
	}
	while (true) {
		if (options.iceGatheringState() == "complete") return "complete"
		delay(ICE_GATHERING_POLL_MS)
		if (options.iceGatheringState() == "complete") return "complete"
		val candidates = options.candidateCount?.invoke() ?: 0
		if (candidates <= 0) {
			// 一个候选都没收到，再等也不会变：放行让 DTLS/数据通道自己判成败。
			val elapsedMs = System.currentTimeMillis() - startedAt
			if (elapsedMs >= options.stallMs) {
				options.onStall?.invoke(elapsedMs)
				return "stalled"
			}
			failIfOverdue()
			continue
		}
		// 有候选了：等「再无新候选」的窗口过去；窗口内又来候选就重新计时。
		delay(options.settleMs)
		if (options.iceGatheringState() == "complete") return "complete"
		if ((options.candidateCount?.invoke() ?: 0) == candidates) return "stable"
		failIfOverdue()
	}
}

/**
 * 建立 WebRTC link（双 DataChannel + discovery 信令）。
 *
 * ICE 本地主机名策略按观测结果逐级升级（见 [iceLocalHostnameLadder]）：一级 gathering 后没收到任何候选
 * 就换更宽松的一级重建 peer connection 重发 offer（**全新一次建链尝试**，不是重新协商已有连接，
 * 所以 DTLS 指纹绑定语义不变）。接受方按 offer 里的 `rung` 在同级重建并回 answer，自身不升级，
 * 故收敛有界。
 * @param options link 配置
 * @return link 句柄
 */
suspend fun createWebRtcLink(options: WebRtcLinkOptions): LinkHandle {
	val handshakeTimeoutMs = options.handshakeTimeoutMs ?: ms("10s")
	val channelOpenTimeoutMs = maxOf(handshakeTimeoutMs, ms("30s"))
	val rtc = options.rtc ?: loadNodeRtcPolyfill()
	val webrtcConfig = (getSignalingRuntimeConfig()["channels"] as? Map<*, *>)?.get("webrtc") as? Map<*, *>
	val rungs = iceLocalHostnameLadder(webrtcConfig?.get("iceLocalHostnamePolicy")?.toString())
	val peerConfig = if (!options.iceServers.isNullOrEmpty()) mapOf("iceServers" to options.iceServers) else null
	val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
	val remoteSignalQueue = ArrayList<Map<String, Any?>>()
	val seenRemoteSignals = LruMap<String, Boolean>(1024)
	var peerConnection: RtcPeerConnectionLike = rtc.createPeerConnection(peerConfig)
	var remoteDescriptionSet = false
	var controlChannel: RtcDataChannel? = null
	var bulkChannel: RtcDataChannel? = null
	var sendQueues: ChannelSendQueues? = null
	var controlLowEvents = 0
	var bulkLowEvents = 0
	var reconnectCount = 0
	var rungIndex = 0
	/** 当前一级收到的可用候选数（`drop` 策略下 `.local` 候选在此被剔除）。 */
	var usableCandidateCount = 0
	/**
	 * 当前 rungIndex 级是否已重建并挂过回调。
	 *
	 * JVM 侧的 `peerConnection` 不是可空引用，所以「还没建」没法用它判断；这个标志就是那件事，
	 * 保证入站信令到达时按当前级补建一次，而不是每份信令都重建。
	 */
	var rungReady = false

	suspend fun sendSignal(message: Map<String, Any?>) {
		options.signal.send(message)
	}

	val pipe = LinkPipe(
		LinkPipeOptions(
			providerId = "webrtc",
			level = LINK_LEVEL_WEBRTC,
			initiator = options.initiator,
			nodeHash = options.nodeHash,
			localIdentity = options.localIdentity,
			heartbeatMs = options.heartbeatMs ?: ms("15s"),
			idleTimeoutMs = options.idleTimeoutMs ?: ms("45s"),
			handshakeTimeoutMs = handshakeTimeoutMs,
			getLocalBinding = { extractDtlsFingerprint(peerConnection.localDescriptionSdp()) },
			getRemoteBinding = { extractDtlsFingerprint(peerConnection.remoteDescriptionSdp()) },
			sendControlText = { text ->
				val channel = controlChannel ?: throw IllegalStateException("p2p: control channel unavailable")
				channel.send(text.toByteArray(Charsets.UTF_8))
			},
			sendFrame = { action, frame ->
				val queues = sendQueues ?: throw IllegalStateException("p2p: send queues unavailable")
				queues.enqueue(action, frame)
			},
			closeTransport = {
				sendQueues?.clear()
				runCatching { controlChannel?.close() }
				runCatching { bulkChannel?.close() }
				runCatching { peerConnection.close() }
			},
			extraStats = {
				linkedMapOf(
					"connectionState" to peerConnection.connectionState,
					"iceConnectionState" to peerConnection.iceConnectionState,
					"iceLocalHostnamePolicy" to rungs[rungIndex],
					"iceRung" to rungIndex.toDouble(),
					"reconnectCount" to reconnectCount.toDouble(),
					"pending" to (sendQueues?.pending() ?: linkedMapOf("control" to 0, "bulk" to 0)),
					"controlBufferedAmount" to (controlChannel?.bufferedAmount ?: 0.0),
					"bulkBufferedAmount" to (bulkChannel?.bufferedAmount ?: 0.0),
					"controlLowEvents" to controlLowEvents.toDouble(),
					"bulkLowEvents" to bulkLowEvents.toDouble(),
				)
			},
		),
	)

	fun attachBackpressurePump(channel: RtcDataChannel) {
		configureBufferedAmountLowThreshold(channel, CHANNEL_LOW_THRESHOLD_BYTES.toDouble())
		onBufferedAmountLow(channel) {
			if (channel.label == CHANNEL_CONTROL) {
				controlLowEvents++
				sendQueues?.flush(CHANNEL_CONTROL)
			}
			else if (channel.label == CHANNEL_BULK) {
				bulkLowEvents++
				sendQueues?.flush(CHANNEL_BULK)
			}
		}
	}

	suspend fun flushQueuedIceCandidates() {
		if (!remoteDescriptionSet || peerConnection.localDescription == null) return
		while (remoteSignalQueue.isNotEmpty()) {
			val candidate = remoteSignalQueue.first()
			try {
				peerConnection.addIceCandidate(candidate)
				remoteSignalQueue.removeAt(0)
			}
			catch (error: Exception) {
				if (Regex("without ice transport", RegexOption.IGNORE_CASE).containsMatchIn(formatErrorReason(error))) return
				throw error
			}
		}
	}

	suspend fun applyRemoteDescription(description: Map<String, Any?>) {
		peerConnection.setRemoteDescription(description)
		remoteDescriptionSet = true
		flushQueuedIceCandidates()
	}

	/**
	 * 等本地候选收齐并回报本次是否收到过候选（停滞判定见 [collectIceGathering]）。
	 * @return 是否收到过可用候选
	 */
	suspend fun waitForIceGatheringComplete(): Boolean {
		try {
			collectIceGathering(
				IceGatheringOptions(
					iceGatheringState = { peerConnection.iceGatheringState },
					candidateCount = { usableCandidateCount },
					handshakeTimeoutMs = handshakeTimeoutMs,
					settleMs = options.iceCandidateSettleMs ?: ICE_CANDIDATE_SETTLE_MS,
					stallMs = options.iceGatheringStallMs ?: ICE_GATHERING_STALL_MS,
					onStall = { elapsedMs ->
						nodeDebug(
							"p2p:webrtc ice gathering stalled without candidates",
							linkedMapOf(
								"elapsedMs" to elapsedMs.toDouble(),
								"rung" to rungIndex.toDouble(),
								"policy" to rungs[rungIndex],
								"iceServers" to (options.iceServers?.size ?: 0).toDouble(),
							),
						)
					},
				),
			)
		}
		catch (error: Exception) {
			pipe.close("ice-gathering-timeout")
			throw error
		}
		return usableCandidateCount > 0
	}

	/**
	 * 处理入站信令。
	 * @param message 信令消息
	 * @param buildPeer 按阶梯下标重建 peer connection（声明顺序上晚于本函数，故显式传入）
	 */
	suspend fun handleRemoteSignal(message: Map<String, Any?>, buildPeer: (Int) -> Unit) {
		val type = message["type"] as? String ?: return
		val candidate = message["candidate"] as? Map<String, Any?>
		// 信令与建链是并发的：任何入站信令都要先确保当前这一级已有可用 pc。
		if (!rungReady) buildPeer(rungIndex)
		val signalKey = if (type == "ice" && candidate != null)
			"ice:${candidate["candidate"] ?: ""}:${candidate["sdpMid"] ?: ""}:${candidate["sdpMLineIndex"] ?: ""}"
		else Json.stringify(message) ?: ""
		if (seenRemoteSignals.contains(signalKey)) return
		seenRemoteSignals.touch(signalKey, true)
		val description = message["description"] as? Map<String, Any?>
		if (type == "description" && description != null) {
			// 接受方按 offer 的级号重建，保证自己的候选过滤策略与发起方同一级；自身不升级，
			// 所以阶梯收敛有界（由发起方的观测结果驱动）。
			val remoteRung = (message["rung"] as? Number)?.toInt() ?: 0
			if (description["type"] == "offer" && !options.initiator && remoteRung != rungIndex)
				buildPeer(remoteRung)
			if (description["type"] == "answer" && peerConnection.signalingState == "stable") return
			applyRemoteDescription(description)
			if (description["type"] == "offer") {
				val answer = peerConnection.createAnswer()
				peerConnection.setLocalDescription(answer)
				flushQueuedIceCandidates()
				val hasCandidates = waitForIceGatheringComplete()
				nodeDebug(
					"p2p:webrtc answer gathered",
					linkedMapOf(
						"rung" to rungIndex.toDouble(),
						"policy" to rungs[rungIndex],
						"candidates" to usableCandidateCount.toDouble(),
						"hasCandidates" to hasCandidates,
					),
				)
				// 与 offer 同样保持信令外壳：`{ type: "description", rung, description: <本地描述> }`。
				val payload = linkedMapOf<String, Any?>("type" to "description", "rung" to rungIndex.toDouble())
				payload["description"] = peerConnection.localDescription ?: answer
				sendSignal(payload)
				pipe.maybeSendAuth()
			}
			return
		}
		if (type == "ice" && candidate != null) {
			if (!remoteDescriptionSet || peerConnection.localDescription == null || peerConnection.signalingState != "stable") {
				remoteSignalQueue.add(candidate)
				return
			}
			try {
				peerConnection.addIceCandidate(candidate)
			}
			catch (error: Exception) {
				if (Regex("without ice transport", RegexOption.IGNORE_CASE).containsMatchIn(formatErrorReason(error))) {
					remoteSignalQueue.add(candidate)
					return
				}
				throw error
			}
		}
	}

	fun attachChannel(channel: RtcDataChannel) {
		if (channel.label == CHANNEL_CONTROL) controlChannel = channel
		else if (channel.label == CHANNEL_BULK) bulkChannel = channel
		else return
		channel.onMessage = { data ->
			try {
				pipe.handleInbound(if (data is String) data else toBytes(data, allowString = true))
			}
			catch (_: Exception) {
				// drop
			}
		}
		attachBackpressurePump(channel)
	}

	suspend fun maybeStartPostOpenFlow() {
		val control = controlChannel ?: return
		val bulk = bulkChannel ?: return
		waitForChannelState(control, "open", channelOpenTimeoutMs)
		waitForChannelState(bulk, "open", channelOpenTimeoutMs)
		if (sendQueues == null)
			sendQueues = createChannelSendQueues({ name -> if (name == CHANNEL_CONTROL) controlChannel else bulkChannel })
		pipe.startHandshake()
	}

	/**
	 * 给 peer connection 挂上事件与回调（换级重建后需重新挂）。
	 *
	 * 候选按当前一级的策略过滤：`drop` 丢掉 `.local`、`rewrite-loopback` 改写成回环地址、
	 * `none` 原样保留。候选不单独外发（随 description 一次性带出），过滤在这里只影响进度计数。
	 */
	fun attachPeerConnection() {
		val policy = rungs[rungIndex]
		peerConnection.onIceCandidate = { event ->
			val candidateMap = event?.get("candidate") as? Map<*, *>
			if (candidateMap == null) {
				// 后端只给外层的 `{ candidate }` 包装时，直接按可用候选计数。
				if (event != null) usableCandidateCount++
			}
			else
				try {
					val candidate = RtcIceCandidate(
						candidate = candidateMap["candidate"] as? String,
						sdpMid = candidateMap["sdpMid"] as? String,
						sdpMLineIndex = (candidateMap["sdpMLineIndex"] as? Number)?.toInt(),
					)
					if (filterIceLocalHostnameCandidate(candidate, policy) != null) usableCandidateCount++
				}
				catch (_: Exception) {
					usableCandidateCount++
				}
		}
		peerConnection.onDataChannel = { channel ->
			attachChannel(channel)
			scope.launch {
				try {
					maybeStartPostOpenFlow()
				}
				catch (error: Exception) {
					pipe.close("channel-attach-failed:${formatErrorReason(error)}")
				}
			}
		}
		peerConnection.onConnectionStateChange = {
			if (peerConnection.connectionState in listOf("failed", "closed", "disconnected")) {
				reconnectCount++
				scope.launch { pipe.close("connection-${peerConnection.connectionState}") }
			}
		}
	}

	/**
	 * 用第 index 级策略重建 peer connection（换级即换 pc：一次全新建链尝试）。
	 * @param index 阶梯下标
	 */
	fun buildPeerConnection(index: Int) {
		rungIndex = index.coerceIn(0, rungs.size - 1)
		peerConnection = rtc.createPeerConnection(peerConfig)
		remoteDescriptionSet = false
		remoteSignalQueue.clear()
		usableCandidateCount = 0
		rungReady = true
		attachPeerConnection()
		nodeDebug(
			"p2p:webrtc ice rung",
			linkedMapOf("rung" to rungIndex.toDouble(), "policy" to rungs[rungIndex], "rungs" to rungs.size.toDouble()),
		)
	}

	attachPeerConnection()

	options.signal.onRemote { message ->
		scope.launch {
			try {
				handleRemoteSignal(message) { index -> buildPeerConnection(index) }
			}
			catch (error: Exception) {
				pipe.close("signal-error:${formatErrorReason(error)}")
			}
		}
	}

	if (options.initiator) {
		// ICE 阶梯：一级 gathering 后一个候选都没有就升到更宽松的一级，用全新 pc 重发 offer。
		// 总预算沿用 handshakeTimeoutMs，故整条阶梯仍有界。
		val ladderDeadline = System.currentTimeMillis() + handshakeTimeoutMs
		var sentOffer = false
		for (index in rungs.indices) {
			buildPeerConnection(index)
			attachChannel(peerConnection.createDataChannel(CHANNEL_CONTROL))
			attachChannel(peerConnection.createDataChannel(CHANNEL_BULK))
			val offer = peerConnection.createOffer()
			peerConnection.setLocalDescription(offer)
			val hasCandidates = waitForIceGatheringComplete()
			nodeDebug(
				"p2p:webrtc offer gathered",
				linkedMapOf(
					"rung" to index.toDouble(),
					"policy" to rungs[index],
					"candidates" to usableCandidateCount.toDouble(),
				),
			)
			val nextIndex = index + 1
			// 候选集为空说明这一级策略把本机候选全滤掉了（例如只产出 mDNS 候选），换更宽松的一级重建。
			// 只在预算内、且还有更宽松的一级时升级；`rewrite-loopback` 起点不会走到这里（阶梯只有它自己）。
			val escalatable = nextIndex < rungs.size
			if (!hasCandidates && escalatable && System.currentTimeMillis() < ladderDeadline) {
				nodeDebug(
					"p2p:webrtc ice rung escalated",
					linkedMapOf("from" to rungs[index], "to" to rungs[nextIndex], "rung" to nextIndex.toDouble()),
				)
				continue
			}
			// 信令外壳是 `{ type: "description", rung, description: <本地描述> }`，绝不可把描述字段摊平到外层，
			// 否则会覆盖外壳的 type 并破坏线上协议（对端按 `message.type == "description"` 分派）。
			val message = linkedMapOf<String, Any?>("type" to "description", "rung" to index.toDouble())
			message["description"] = peerConnection.localDescription ?: offer
			sendSignal(message)
			sentOffer = true
			if (!hasCandidates)
				nodeDebug(
					"p2p:webrtc offer has no usable ice candidates",
					linkedMapOf(
						"rung" to index.toDouble(),
						"policy" to rungs[index],
						"escalatable" to escalatable,
						"iceServers" to (options.iceServers?.size ?: 0).toDouble(),
					),
				)
			break
		}
		if (!sentOffer) {
			pipe.close("ice-candidates-empty")
			throw IllegalStateException("p2p: no usable ice candidates after the local hostname ladder")
		}
	}

	scope.launch {
		try {
			maybeStartPostOpenFlow()
		}
		catch (error: Exception) {
			pipe.close("open-flow-failed:${formatErrorReason(error)}")
		}
	}

	return asLinkHandle(
		pipe,
		mapOf(
			"channelForTest" to fun(name: String): RtcDataChannel? = if (name == CHANNEL_CONTROL) controlChannel else bulkChannel,
		),
	)
}

/**
 * 创建 WebRTC LinkProvider。
 * @param options 可选覆盖（测试注入）
 * @return WebRTC provider
 */
@JvmOverloads
fun createWebRtcLinkProvider(options: Map<String, Any?> = emptyMap()): LinkProvider {
	@Suppress("UNCHECKED_CAST")
	val createImpl = options["createWebRtcLink"] as? (suspend (WebRtcLinkOptions) -> LinkHandle)
	return object : LinkProvider {
		override val id: String = "webrtc"
		override val level: Double = LINK_LEVEL_WEBRTC
		override val caps: Map<String, Any?> = mapOf("needsOfferAnswer" to true, "needsDiscoverySignal" to true, "probe" to "native")

		override suspend fun isAvailable(): Boolean = canUseWebRtcLink()

		override suspend fun dial(options: Map<String, Any?>): LinkHandle? = dialWebRtc(options, initiator = true, createImpl)

		override suspend fun accept(options: Map<String, Any?>): LinkHandle? = dialWebRtc(options, initiator = false, createImpl)
	}
}

private fun buildWebRtcOptions(options: Map<String, Any?>, initiator: Boolean): WebRtcLinkOptions {
	@Suppress("UNCHECKED_CAST")
	val signal = options["signal"] as? RtcSignal
		?: throw IllegalStateException("p2p: webrtc requires signal")
	return WebRtcLinkOptions(
		nodeHash = options["nodeHash"]?.toString(),
		initiator = initiator,
		signal = signal,
		iceServers = options["iceServers"] as? List<Any?>,
		heartbeatMs = (options["heartbeatMs"] as? Number)?.toLong(),
		idleTimeoutMs = (options["idleTimeoutMs"] as? Number)?.toLong(),
		handshakeTimeoutMs = (options["handshakeTimeoutMs"] as? Number)?.toLong(),
		rtc = options["rtc"] as? RtcProvider,
		localIdentity = @Suppress("UNCHECKED_CAST") (options["localIdentity"] as? Map<String, Any?>),
	)
}

private suspend fun dialWebRtc(
	options: Map<String, Any?>,
	initiator: Boolean,
	createImpl: (suspend (WebRtcLinkOptions) -> LinkHandle)?,
): LinkHandle {
	val built = buildWebRtcOptions(options, initiator)
	return createImpl?.invoke(built) ?: createWebRtcLink(built)
}
