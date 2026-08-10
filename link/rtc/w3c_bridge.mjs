/**
 * 把 EventEmitter 风格的 RTC（如 node-rtc-connection）桥成 W3C 属性 handler。
 * 其余链路只认 onicecandidate / onmessage / onbufferedamountlow 等。
 */

/** @type {WeakSet<object>} */
const bridgedChannels = new WeakSet()

/**
 * @param {object} target EventEmitter 目标
 * @param {string} property W3C 属性名（如 onmessage）
 * @param {string} eventName EventEmitter 事件名
 * @param {(payload: unknown) => unknown} [adapt] 事件载荷适配
 * @returns {void}
 */
function defineEmitterHandler(target, property, eventName, adapt = payload => payload) {
	let handler = null
	target.on(eventName, payload => handler?.(adapt(payload)))
	Object.defineProperty(target, property, {
		configurable: true,
		enumerable: true,
		/**
		 * @returns {((payload: unknown) => void) | null} 当前 handler
		 */
		get: () => handler,
		/**
		 * @param {((payload: unknown) => void) | null} value 新 handler
		 * @returns {void}
		 */
		set: value => { handler = value },
	})
}

/**
 * @param {RTCDataChannel} channel 原始 data channel
 * @returns {RTCDataChannel} 已挂 W3C handler 的通道
 */
export function bridgeDataChannel(channel) {
	if (bridgedChannels.has(channel) || typeof channel.on !== 'function') return channel
	bridgedChannels.add(channel)
	defineEmitterHandler(channel, 'onmessage', 'message')
	defineEmitterHandler(channel, 'onopen', 'open')
	defineEmitterHandler(channel, 'onclose', 'close')
	defineEmitterHandler(channel, 'onbufferedamountlow', 'bufferedamountlow')
	return channel
}

/**
 * @param {typeof RTCPeerConnection} BaseRTC EventEmitter 风格 RTCPeerConnection
 * @returns {typeof RTCPeerConnection} W3C handler 版
 */
export function bridgePeerConnection(BaseRTC) {
	return class W3cRtcPeerConnection extends BaseRTC {
		/** @type {((event: RTCPeerConnectionIceEvent) => void) | null} */
		#iceHandler = null
		/** @type {((event: { channel: RTCDataChannel }) => void) | null} */
		#dataChannelHandler = null
		/** @type {(() => void) | null} */
		#connectionStateHandler = null
		/** @type {Map<string, Set<(event: unknown) => void>>} */
		#listeners = new Map()

		/**
		 * @param {RTCConfiguration} [config] RTC 配置
		 */
		constructor(config) {
			super(config)
			super.on('icecandidate', event => {
				const normalized = this.prepareIceCandidateEvent(event)
				if (normalized == null) return
				this.#iceHandler?.(normalized)
				this.#emit('icecandidate', normalized)
			})
			super.on('datachannel', event => {
				const adapted = { channel: bridgeDataChannel(event.channel) }
				this.#dataChannelHandler?.(adapted)
				this.#emit('datachannel', adapted)
			})
			super.on('connectionstatechange', () => {
				this.#connectionStateHandler?.()
				this.#emit('connectionstatechange', undefined)
			})
		}

		/**
		 * ICE 事件规范化钩子；子类可覆盖（drop 返回 null，rewrite 返回替换后的事件）。
		 * @param {RTCPeerConnectionIceEvent | { candidate?: unknown }} event 原始 ICE 事件
		 * @returns {RTCPeerConnectionIceEvent | { candidate?: unknown } | null} 规范化后的事件
		 */
		prepareIceCandidateEvent(event) {
			return event
		}

		/**
		 * @param {string} type 事件名
		 * @param {unknown} event 事件载荷（icecandidate 须已规范化）
		 * @returns {void}
		 */
		#emit(type, event) {
			const listeners = this.#listeners.get(type)
			if (!listeners) return
			for (const listener of listeners) listener(event)
		}

		/**
		 * @param {string} type 事件名
		 * @param {(event: unknown) => void} listener 回调
		 * @returns {void}
		 */
		addEventListener(type, listener) {
			let listeners = this.#listeners.get(type)
			if (!listeners) {
				listeners = new Set()
				this.#listeners.set(type, listeners)
			}
			listeners.add(listener)
		}

		/**
		 * @param {string} type 事件名
		 * @param {(event: unknown) => void} listener 回调
		 * @returns {void}
		 */
		removeEventListener(type, listener) {
			this.#listeners.get(type)?.delete(listener)
		}

		/** @returns {((event: RTCPeerConnectionIceEvent) => void) | null} ICE candidate handler */
		get onicecandidate() { return this.#iceHandler }
		/** @param {((event: RTCPeerConnectionIceEvent) => void) | null} handler ICE candidate handler */
		set onicecandidate(handler) { this.#iceHandler = handler }

		/** @returns {((event: { channel: RTCDataChannel }) => void) | null} data channel handler */
		get ondatachannel() { return this.#dataChannelHandler }
		/** @param {((event: { channel: RTCDataChannel }) => void) | null} handler data channel handler */
		set ondatachannel(handler) { this.#dataChannelHandler = handler }

		/** @returns {(() => void) | null} connection state handler */
		get onconnectionstatechange() { return this.#connectionStateHandler }
		/** @param {(() => void) | null} handler connection state handler */
		set onconnectionstatechange(handler) { this.#connectionStateHandler = handler }

		/**
		 * @param {string} label data channel 标签
		 * @param {RTCDataChannelInit} [init] 创建选项
		 * @returns {RTCDataChannel} 已桥接 W3C handler 的通道
		 */
		createDataChannel(label, init) {
			return bridgeDataChannel(super.createDataChannel(label, init))
		}
	}
}
