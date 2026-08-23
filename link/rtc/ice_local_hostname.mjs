/**
 * 服务端 WebRTC polyfill 在 Windows 等环境常产出 `.local` host candidate，
 * 远端无法解析。按 iceLocalHostnamePolicy 改写为 loopback 或丢弃。
 */

/** @typedef {'none' | 'rewrite-loopback' | 'drop'} IceLocalHostnamePolicy */

/**
 * @param {string | null | undefined} candidateSdp ICE candidate SDP 行
 * @param {IceLocalHostnamePolicy} policy 处理策略
 * @returns {string | null} 处理后的 SDP；drop 策略下不可用时返回 null
 */
export function applyIceLocalHostnamePolicy(candidateSdp, policy) {
	const sdp = candidateSdp || ''
	if (!sdp || !/\.local/i.test(sdp)) return sdp || null
	if (!/\btyp host\b/i.test(sdp)) return sdp
	if (policy === 'drop') return null
	if (policy === 'rewrite-loopback') {
		const rewritten = sdp.replace(/(\s)[\w-]+\.local(\s|$)/gi, '$1127.0.0.1$2')
		return rewritten === sdp ? null : rewritten
	}
	return sdp
}

/**
 * @param {RTCIceCandidate | { candidate?: string } | null | undefined} candidate ICE candidate
 * @param {typeof RTCIceCandidate} RTCIceCandidateCtor 构造函数
 * @param {IceLocalHostnamePolicy} policy 处理策略
 * @returns {RTCIceCandidate | { candidate?: string } | null | undefined} 过滤/改写后的 candidate
 */
export function filterIceLocalHostnameCandidate(candidate, RTCIceCandidateCtor, policy) {
	if (!candidate || policy === 'none') return candidate
	const raw = candidate.candidate ?? candidate.toJSON?.()?.candidate ?? ''
	const rewritten = applyIceLocalHostnamePolicy(raw, policy)
	if (!rewritten) return null
	if (rewritten === raw) return candidate
	const init = {
		...candidate.toJSON?.() || { sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex },
		candidate: rewritten,
	}
	return new RTCIceCandidateCtor(init)
}

/**
 * @param {typeof RTCPeerConnection} BaseRTC 原始 polyfill 类
 * @param {typeof RTCIceCandidate} RTCIceCandidate ICE candidate 构造函数
 * @param {IceLocalHostnamePolicy} [policy='drop'] 策略
 * @returns {typeof RTCPeerConnection} 包装后的 RTCPeerConnection 类（none 时原样返回）
 */
export function wrapRtcPeerConnectionForIceLocalHostname(BaseRTC, RTCIceCandidate, policy = 'drop') {
	if (policy === 'none') return BaseRTC

	return class IceLocalHostnameFilteredRTCPeerConnection extends BaseRTC {
		/** @type {((event: RTCPeerConnectionIceEvent) => void) | null} */
		#userIceHandler = null

		/**
		 * drop：不派发；rewrite：构造仅携带替换 candidate 的派生事件。
		 * @param {RTCPeerConnectionIceEvent | { candidate?: unknown }} event 原始 ICE 事件
		 * @returns {RTCPeerConnectionIceEvent | { candidate?: unknown } | null} 规范化后的事件；drop 时为 null
		 */
		prepareIceCandidateEvent(event) {
			if (!event?.candidate) return event
			const filtered = filterIceLocalHostnameCandidate(event.candidate, RTCIceCandidate, policy)
			if (!filtered) return null
			if (filtered === event.candidate) return event
			const rewritten = new event.constructor('icecandidate')
			rewritten.candidate = filtered
			return rewritten
		}

		/**
		 * @param {RTCConfiguration} [config] RTC 配置
		 */
		constructor(config) {
			super(config)
			Object.defineProperty(this, 'onicecandidate', {
				configurable: true,
				enumerable: true,
				/**
				 * @returns {((event: RTCPeerConnectionIceEvent) => void) | null} 用户 ICE handler
				 */
				get: () => this.#userIceHandler,
				/**
				 * @param {((event: RTCPeerConnectionIceEvent) => void) | null} handler 用户 ICE handler
				 * @returns {void}
				 */
				set: handler => { this.#userIceHandler = handler },
			})
		}

		/**
		 * 先完成 candidate 转换，再走标准 EventTarget 派发（保留 once/AbortSignal/capture 语义）。
		 * addEventListener / removeEventListener 交由基类，故 once / AbortSignal / capture 均保留。
		 * drop：不派发；pass-through：派发原事件；rewrite：派发替换 candidate 后的派生事件。
		 * @param {Event} event 待派发事件
		 * @returns {boolean} 事件是否未被取消
		 */
		dispatchEvent(event) {
			if (event?.type !== 'icecandidate') return super.dispatchEvent(event)
			const normalized = this.prepareIceCandidateEvent(event)
			if (normalized == null) return true
			this.#userIceHandler?.(normalized)
			if (normalized === event) return super.dispatchEvent(event)
			return super.dispatchEvent(normalized)
		}
	}
}
