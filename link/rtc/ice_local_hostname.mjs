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

	const baseRoutesIce = typeof BaseRTC.prototype.prepareIceCandidateEvent === 'function'

	return class IceLocalHostnameFilteredRTCPeerConnection extends BaseRTC {
		/** @type {((event: RTCPeerConnectionIceEvent) => void) | null} */
		#userIceHandler = null
		/** @type {Set<(event: unknown) => void>} */
		#iceListeners = new Set()
		/** 去重：同一次 native 派发可能既走 attribute 又走 listener */
		#lastIceEvent = null

		/**
		 * drop：不派发；rewrite：仅派发替换 candidate 后的事件。
		 * @param {RTCPeerConnectionIceEvent | { candidate?: unknown }} event 原始 ICE 事件
		 * @returns {RTCPeerConnectionIceEvent | { candidate?: unknown } | null} 规范化后的事件；drop 时为 null
		 */
		prepareIceCandidateEvent(event) {
			if (!event?.candidate) return event
			const filtered = filterIceLocalHostnameCandidate(event.candidate, RTCIceCandidate, policy)
			if (!filtered) return null
			return filtered === event.candidate ? event : { candidate: filtered }
		}

		/**
		 * @param {RTCConfiguration} [config] RTC 配置
		 */
		constructor(config) {
			super(config)
			if (baseRoutesIce) return

			// native EventTarget：在派发前规范化，自管 listener，不依赖 stopImmediatePropagation。
			Object.defineProperty(this, 'onicecandidate', {
				configurable: true,
				enumerable: true,
				/**
				 * @returns {((event: RTCPeerConnectionIceEvent) => void) | null} 用户 ICE handler
				 */
				get: () => this.#userIceHandler ? this.#deliverIce : null,
				/**
				 * @param {((event: RTCPeerConnectionIceEvent) => void) | null} handler 用户 ICE handler
				 * @returns {void}
				 */
				set: handler => { this.#userIceHandler = handler },
			})
			super.addEventListener('icecandidate', event => this.#deliverIce(event))
		}

		/**
		 * @param {RTCPeerConnectionIceEvent | { candidate?: unknown }} event 原始 ICE 事件
		 * @returns {void}
		 */
		#deliverIce = event => {
			if (this.#lastIceEvent === event) return
			this.#lastIceEvent = event
			const normalized = this.prepareIceCandidateEvent(event)
			if (normalized == null) return
			this.#userIceHandler?.(normalized)
			for (const listener of this.#iceListeners) listener(normalized)
		}

		/**
		 * @param {string} type 事件名
		 * @param {(event: unknown) => void} listener 回调
		 * @param {boolean | AddEventListenerOptions} [options] 监听选项
		 * @returns {void}
		 */
		addEventListener(type, listener, options) {
			if (!baseRoutesIce && type === 'icecandidate') {
				this.#iceListeners.add(listener)
				return
			}
			return super.addEventListener(type, listener, options)
		}

		/**
		 * @param {string} type 事件名
		 * @param {(event: unknown) => void} listener 回调
		 * @param {boolean | EventListenerOptions} [options] 监听选项
		 * @returns {void}
		 */
		removeEventListener(type, listener, options) {
			if (!baseRoutesIce && type === 'icecandidate') {
				this.#iceListeners.delete(listener)
				return
			}
			return super.removeEventListener(type, listener, options)
		}
	}
}
