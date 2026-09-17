package io.github.steve02081504.fountp2p.link.rtc

/**
 * ICE candidate 本地主机名策略（等价 JS `ice_local_hostname.mjs`）。
 *
 * 平台抽象：Android 无 DOM EventTarget/RTCPeerConnection，Kotlin 侧以
 * [RtcPeerConnectionBase] / [RtcIceCandidate] 建模，`wrapRtcPeerConnectionForIceLocalHostname`
 * 返回工厂函数（而非 JS 的子类），语义一致。
 */

/** `none` / `rewrite-loopback` / `drop`。 */
typealias IceLocalHostnamePolicy = String

/** 测试/宿主用 ICE candidate。 */
open class RtcIceCandidate(
	val candidate: String? = null,
	val sdpMid: String? = null,
	val sdpMLineIndex: Int? = null,
) {
	/** @return 可序列化初始化字段 */
	open fun toJSON(): Map<String, Any?> = linkedMapOf(
		"candidate" to candidate,
		"sdpMid" to sdpMid,
		"sdpMLineIndex" to sdpMLineIndex?.toDouble(),
	)
}

/** ICE candidate 事件。 */
open class RtcIceCandidateEvent(val type: String, var candidate: RtcIceCandidate? = null)

/**
 * RTCPeerConnection 最小抽象（覆盖 onicecandidate 与 addEventListener 语义）。
 */
open class RtcPeerConnectionBase {
	/** 用户 `onicecandidate` 处理器。 */
	open var onIceCandidate: ((RtcIceCandidateEvent) -> Unit)? = null
	private val iceListeners = LinkedHashSet<(RtcIceCandidateEvent) -> Unit>()

	/**
	 * @param type 事件名
	 * @param listener 监听器
	 */
	open fun addEventListener(type: String, listener: (RtcIceCandidateEvent) -> Unit) {
		if (type == "icecandidate") iceListeners.add(listener)
	}

	/**
	 * @param type 事件名
	 * @param listener 监听器
	 */
	open fun removeEventListener(type: String, listener: (RtcIceCandidateEvent) -> Unit) {
		if (type == "icecandidate") iceListeners.remove(listener)
	}

	/**
	 * 派发事件给 addEventListener 监听器（不触发 [onIceCandidate]，与 DOM EventTarget 一致）。
	 * @param event 待派发事件
	 * @return 事件是否未被取消
	 */
	open fun dispatchEvent(event: RtcIceCandidateEvent): Boolean {
		if (event.type == "icecandidate") for (listener in iceListeners.toList()) listener(event)
		return true
	}

	/**
	 * 测试/宿主用：派发一个 ICE candidate。
	 * @param candidate candidate 载荷
	 * @return 事件是否未被取消
	 */
	fun emitIce(candidate: RtcIceCandidate?): Boolean = dispatchEvent(RtcIceCandidateEvent("icecandidate", candidate))
}

/**
 * @param candidateSdp ICE candidate SDP 行
 * @param policy 处理策略
 * @return 处理后的 SDP；drop 策略下不可用时返回 null
 */
fun applyIceLocalHostnamePolicy(candidateSdp: String?, policy: IceLocalHostnamePolicy): String? {
	val sdp = candidateSdp ?: ""
	if (sdp.isEmpty() || !Regex("\\.local", RegexOption.IGNORE_CASE).containsMatchIn(sdp)) return if (sdp.isEmpty()) null else sdp
	if (!Regex("\\btyp host\\b", RegexOption.IGNORE_CASE).containsMatchIn(sdp)) return sdp
	if (policy == "drop") return null
	if (policy == "rewrite-loopback") {
		val rewritten = sdp.replace(Regex("(\\s)[\\w-]+\\.local(\\s|$)", RegexOption.IGNORE_CASE), "$1127.0.0.1$2")
		return if (rewritten == sdp) null else rewritten
	}
	return sdp
}

/**
 * @param candidate ICE candidate
 * @param policy 处理策略
 * @return 过滤/改写后的 candidate
 */
fun filterIceLocalHostnameCandidate(candidate: RtcIceCandidate?, policy: IceLocalHostnamePolicy): RtcIceCandidate? {
	if (candidate == null || policy == "none") return candidate
	val raw = candidate.candidate ?: (candidate.toJSON()["candidate"] as? String) ?: ""
	val rewritten = applyIceLocalHostnamePolicy(raw, policy)
	if (rewritten == null) return null
	if (rewritten == raw) return candidate
	return RtcIceCandidate(rewritten, candidate.sdpMid, candidate.sdpMLineIndex)
}

/**
 * `policy != none` 时的包装 peer connection：先完成 candidate 转换，再走 addEventListener 派发。
 * @param policy 处理策略
 */
class IceLocalHostnameFilteredRtcPeerConnection(private val policy: IceLocalHostnamePolicy) : RtcPeerConnectionBase() {
	private var userIceHandler: ((RtcIceCandidateEvent) -> Unit)? = null

	override var onIceCandidate: ((RtcIceCandidateEvent) -> Unit)?
		get() = userIceHandler
		set(handler) {
			userIceHandler = handler
		}

	/**
	 * drop：不派发；rewrite：构造仅携带替换 candidate 的派生事件。
	 * @param event 原始 ICE 事件
	 * @return 规范化后的事件；drop 时为 null
	 */
	fun prepareIceCandidateEvent(event: RtcIceCandidateEvent?): RtcIceCandidateEvent? {
		if (event == null || event.candidate == null) return event
		val filtered = filterIceLocalHostnameCandidate(event.candidate, policy)
		if (filtered == null) return null
		if (filtered === event.candidate) return event
		return RtcIceCandidateEvent("icecandidate", filtered)
	}

	override fun dispatchEvent(event: RtcIceCandidateEvent): Boolean {
		if (event.type != "icecandidate") return super.dispatchEvent(event)
		val normalized = prepareIceCandidateEvent(event) ?: return true
		userIceHandler?.invoke(normalized)
		return super.dispatchEvent(normalized)
	}
}

/**
 * @param policy 处理策略
 * @return 包装后的 RTCPeerConnection 工厂（none 时返回原始基类实例）
 */
fun wrapRtcPeerConnectionForIceLocalHostname(policy: IceLocalHostnamePolicy = "drop"): () -> RtcPeerConnectionBase =
	if (policy == "none") { { RtcPeerConnectionBase() } } else { { IceLocalHostnameFilteredRtcPeerConnection(policy) } }
