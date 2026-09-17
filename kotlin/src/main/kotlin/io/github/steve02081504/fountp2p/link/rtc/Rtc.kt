package io.github.steve02081504.fountp2p.link.rtc

import io.github.steve02081504.fountp2p.link.RtcDataChannel
import io.github.steve02081504.fountp2p.node.getRtcPolyfillCacheEpoch

/**
 * RTC 平台抽象（Android/JVM 无原生 WebRTC；由宿主注入 node-datachannel / 纯 JS 等价实现）。
 */
interface RtcPeerConnectionLike {
	/** 本地 SDP 描述（含 `{ type, sdp }`）。 */
	var localDescription: Map<String, Any?>?

	/** 远端 SDP 描述。 */
	var remoteDescription: Map<String, Any?>?

	/** Signaling 状态。 */
	val signalingState: String

	/** ICE gathering 状态。 */
	val iceGatheringState: String

	/** 连接状态。 */
	val connectionState: String

	/** ICE 连接状态。 */
	val iceConnectionState: String

	/** ICE candidate 回调（`{ candidate: { candidate, sdpMid, sdpMLineIndex } }` 或 null）。 */
	var onIceCandidate: ((Map<String, Any?>?) -> Unit)?

	/** 远端 data channel 回调。 */
	var onDataChannel: ((RtcDataChannel) -> Unit)?

	/** 连接状态变更回调。 */
	var onConnectionStateChange: (() -> Unit)?

	/** @return offer 描述 */
	suspend fun createOffer(): Map<String, Any?>

	/** @return answer 描述 */
	suspend fun createAnswer(): Map<String, Any?>

	/**
	 * @param description 本地描述
	 */
	suspend fun setLocalDescription(description: Map<String, Any?>)

	/**
	 * @param description 远端描述
	 */
	suspend fun setRemoteDescription(description: Map<String, Any?>)

	/**
	 * @param candidate ICE candidate
	 */
	suspend fun addIceCandidate(candidate: Map<String, Any?>)

	/**
	 * @param label 通道名
	 * @return 新数据通道
	 */
	fun createDataChannel(label: String): RtcDataChannel

	/** 关闭 peer connection。 */
	suspend fun close()

	/** @return 本地 SDP 文本 */
	fun localDescriptionSdp(): String

	/** @return 远端 SDP 文本 */
	fun remoteDescriptionSdp(): String
}

/** RTC 后端 provider。 */
interface RtcProvider {
	/** 后端标识（`node-datachannel` / `node-rtc-connection` / 宿主自定义）。 */
	val backend: String

	/**
	 * @param config RTC 配置（iceServers 等）
	 * @return 新 peer connection
	 */
	fun createPeerConnection(config: Map<String, Any?>?): RtcPeerConnectionLike
}

private var rtcProvider: RtcProvider? = null
private var providerEpoch = -1

/** @param provider RTC 后端 */
fun setRtcProvider(provider: RtcProvider?) {
	rtcProvider = provider
	providerEpoch = getRtcPolyfillCacheEpoch()
}

/** 清除默认后端缓存（iceLocalHostnamePolicy 变更后调用）。 */
fun clearNodeRtcPolyfillCache() {
	providerEpoch = -1
}

/**
 * 加载 RTC polyfill。默认后端路径会缓存首次成功结果；世代变更后失效。
 * @return RTC 后端
 */
fun loadNodeRtcPolyfill(): RtcProvider {
	val epoch = getRtcPolyfillCacheEpoch()
	if (providerEpoch != epoch) providerEpoch = epoch
	return rtcProvider ?: throw IllegalStateException("p2p: no rtc backend")
}

/**
 * 探测 WebRTC 是否可用（缓存）。
 * @return 可用为 true
 */
fun canUseWebRtcLink(): Boolean = rtcProvider != null
