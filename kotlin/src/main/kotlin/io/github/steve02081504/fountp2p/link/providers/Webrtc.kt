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
import io.github.steve02081504.fountp2p.link.rtc.RtcPeerConnectionLike
import io.github.steve02081504.fountp2p.link.rtc.RtcProvider
import io.github.steve02081504.fountp2p.link.rtc.canUseWebRtcLink
import io.github.steve02081504.fountp2p.link.rtc.loadNodeRtcPolyfill
import io.github.steve02081504.fountp2p.link.rtc.waitForChannelState
import io.github.steve02081504.fountp2p.link.extractDtlsFingerprint
import io.github.steve02081504.fountp2p.node.getSignalingRuntimeConfig
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
)

private fun formatErrorReason(error: Any?): String {
	val message = when (error) {
		is Throwable -> error.message ?: error.toString()
		null -> "unknown-error"
		else -> error.toString()
	}
	return message.replace(Regex("\\s+"), " ").take(240)
}

/**
 * 建立 WebRTC link（双 DataChannel + discovery 信令）。
 * @param options link 配置
 * @return link 句柄
 */
suspend fun createWebRtcLink(options: WebRtcLinkOptions): LinkHandle {
	val handshakeTimeoutMs = options.handshakeTimeoutMs ?: ms("10s")
	val channelOpenTimeoutMs = maxOf(handshakeTimeoutMs, ms("30s"))
	val rtc = options.rtc ?: loadNodeRtcPolyfill()
	val webrtcConfig = (getSignalingRuntimeConfig()["channels"] as? Map<*, *>)?.get("webrtc") as? Map<*, *>
	val trickleIceOff = webrtcConfig?.get("trickleIceOff") == true
	val peerConnection = rtc.createPeerConnection(
		if (!options.iceServers.isNullOrEmpty()) mapOf("iceServers" to options.iceServers) else null,
	)
	val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
	val remoteSignalQueue = ArrayList<Map<String, Any?>>()
	val seenRemoteSignals = LruMap<String, Boolean>(1024)
	var remoteDescriptionSet = false
	var controlChannel: RtcDataChannel? = null
	var bulkChannel: RtcDataChannel? = null
	var sendQueues: ChannelSendQueues? = null
	var controlLowEvents = 0
	var bulkLowEvents = 0
	var reconnectCount = 0

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

	suspend fun waitForIceGatheringComplete() {
		if (!trickleIceOff || peerConnection.iceGatheringState == "complete") return
		val deadline = System.currentTimeMillis() + handshakeTimeoutMs
		while (peerConnection.iceGatheringState != "complete" && System.currentTimeMillis() < deadline) delay(50)
		if (peerConnection.iceGatheringState != "complete") {
			pipe.close("ice-gathering-timeout")
			throw IllegalStateException("p2p: ice gathering incomplete after ${handshakeTimeoutMs}ms")
		}
	}

	suspend fun handleRemoteSignal(message: Map<String, Any?>) {
		val type = message["type"] as? String ?: return
		val candidate = message["candidate"] as? Map<String, Any?>
		val signalKey = if (type == "ice" && candidate != null)
			"ice:${candidate["candidate"] ?: ""}:${candidate["sdpMid"] ?: ""}:${candidate["sdpMLineIndex"] ?: ""}"
		else Json.stringify(message) ?: ""
		if (seenRemoteSignals.contains(signalKey)) return
		seenRemoteSignals.touch(signalKey, true)
		val description = message["description"] as? Map<String, Any?>
		if (type == "description" && description != null) {
			if (description["type"] == "answer" && peerConnection.signalingState == "stable") return
			applyRemoteDescription(description)
			if (description["type"] == "offer") {
				val answer = peerConnection.createAnswer()
				peerConnection.setLocalDescription(answer)
				flushQueuedIceCandidates()
				waitForIceGatheringComplete()
				sendSignal(mapOf("type" to "description", "description" to (peerConnection.localDescription ?: answer)))
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

	options.signal.onRemote { message ->
		scope.launch {
			try {
				handleRemoteSignal(message)
			}
			catch (error: Exception) {
				pipe.close("signal-error:${formatErrorReason(error)}")
			}
		}
	}

	peerConnection.onIceCandidate = { event ->
		if (!trickleIceOff && event != null) {
			scope.launch {
				try {
					sendSignal(mapOf("type" to "ice", "candidate" to (event["candidate"] ?: event)))
				}
				catch (error: Exception) {
					pipe.close("signal-send-failed:${formatErrorReason(error)}")
				}
			}
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

	if (options.initiator) {
		attachChannel(peerConnection.createDataChannel(CHANNEL_CONTROL))
		attachChannel(peerConnection.createDataChannel(CHANNEL_BULK))
		val offer = peerConnection.createOffer()
		peerConnection.setLocalDescription(offer)
		waitForIceGatheringComplete()
		sendSignal(mapOf("type" to "description", "description" to (peerConnection.localDescription ?: offer)))
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
