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
	const sdp = String(candidateSdp || '').trim()
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
	const init = typeof candidate.toJSON === 'function'
		? { ...candidate.toJSON(), candidate: rewritten }
		: { candidate: rewritten, sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex }
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
		 * @param {RTCConfiguration} [config] RTC 配置
		 */
		constructor(config) {
			super(config)
			this.addEventListener('icecandidate', event => {
				if (!this.#userIceHandler) return
				if (!event?.candidate) return this.#userIceHandler(event)
				const filtered = filterIceLocalHostnameCandidate(event.candidate, RTCIceCandidate, policy)
				if (!filtered) return
				this.#userIceHandler(filtered === event.candidate ? event : { candidate: filtered })
			})
		}

		/** @returns {((event: RTCPeerConnectionIceEvent) => void) | null} */
		get onicecandidate() { return this.#userIceHandler }

		/** @param {((event: RTCPeerConnectionIceEvent) => void) | null} handler */
		set onicecandidate(handler) { this.#userIceHandler = handler }
	}
}
