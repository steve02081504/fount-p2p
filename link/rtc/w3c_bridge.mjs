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
		get: () => handler,
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

		/**
		 * @param {RTCConfiguration} [config]
		 */
		constructor(config) {
			super(config)
			super.on('icecandidate', event => this.#iceHandler?.(event))
			super.on('datachannel', event =>
				this.#dataChannelHandler?.({ channel: bridgeDataChannel(event.channel) })
			)
			super.on('connectionstatechange', () => this.#connectionStateHandler?.())
		}

		/** @returns {((event: RTCPeerConnectionIceEvent) => void) | null} */
		get onicecandidate() { return this.#iceHandler }
		/** @param {((event: RTCPeerConnectionIceEvent) => void) | null} handler */
		set onicecandidate(handler) { this.#iceHandler = handler }

		/** @returns {((event: { channel: RTCDataChannel }) => void) | null} */
		get ondatachannel() { return this.#dataChannelHandler }
		/** @param {((event: { channel: RTCDataChannel }) => void) | null} handler */
		set ondatachannel(handler) { this.#dataChannelHandler = handler }

		/** @returns {(() => void) | null} */
		get onconnectionstatechange() { return this.#connectionStateHandler }
		/** @param {(() => void) | null} handler */
		set onconnectionstatechange(handler) { this.#connectionStateHandler = handler }

		/**
		 * @param {string} label
		 * @param {RTCDataChannelInit} [init]
		 * @returns {RTCDataChannel}
		 */
		createDataChannel(label, init) {
			return bridgeDataChannel(super.createDataChannel(label, init))
		}
	}
}
