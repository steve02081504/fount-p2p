import process from 'node:process'

import { toBytes } from '../core/bytes_codec.mjs'
import { getSignalingRuntimeConfig } from '../node/instance.mjs'
import { nodeDebug } from '../node/log.mjs'
import { wrapRtcPeerConnectionForIceLocalHostname } from '../transport/rtc_ice_local_hostname.mjs'

/** @type {boolean} */
let exitCleanupHooked = false

/**
 * @typedef {{ RTCPeerConnection: typeof RTCPeerConnection, RTCIceCandidate: typeof RTCIceCandidate, backend: string }} LoadedRtcPolyfill
 * @typedef {{ id: string, load: () => Promise<{ RTCPeerConnection: typeof RTCPeerConnection, RTCIceCandidate: typeof RTCIceCandidate }> }} RtcBackend
 */

/**
 * 注册进程退出时销毁 libdatachannel 原生资源（首次成功加载后挂一次）。
 * libdatachannel 的原生线程在 pc.close() 后仍需时间回收；进程退出时若原生资源未同步销毁，
 * Windows 上会触发堆损坏（退出码 0xC0000374）。
 * @returns {Promise<void>}
 */
async function ensureNodeDatachannelExitCleanup() {
	if (exitCleanupHooked) return
	exitCleanupHooked = true
	const { cleanup = undefined } = await import('node-datachannel').catch(() => ({}))
	process.on('exit', () => {
		try { cleanup?.() } catch { /* already torn down */ }
	})
}

/**
 * @returns {Promise<{ RTCPeerConnection: typeof RTCPeerConnection, RTCIceCandidate: typeof RTCIceCandidate }>}
 */
async function loadNodeDatachannelBackend() {
	const mod = await import('node-datachannel/polyfill')
	await ensureNodeDatachannelExitCleanup()
	return {
		RTCPeerConnection: mod.RTCPeerConnection,
		RTCIceCandidate: mod.RTCIceCandidate,
	}
}

/**
 * 纯 JS WebRTC DataChannel（Termux / 无 native prebuild 时的 fallback）。
 * node-rtc-connection 用 EventEmitter；桥成 W3C 属性 handler 供本包其余路径使用。
 * @returns {Promise<{ RTCPeerConnection: typeof RTCPeerConnection, RTCIceCandidate: typeof RTCIceCandidate }>}
 */
async function loadNodeRtcConnectionBackend() {
	const mod = await import('node-rtc-connection')
	const BaseRTC = mod.RTCPeerConnection
	/**
	 * EventEmitter → onicecandidate / ondatachannel / onconnectionstatechange。
	 */
	class BridgedRTCPeerConnection extends BaseRTC {
		/** @type {((event: RTCPeerConnectionIceEvent) => void) | null} */
		#iceHandler = null
		/** @type {((event: { channel: RTCDataChannel }) => void) | null} */
		#dcHandler = null
		/** @type {(() => void) | null} */
		#connHandler = null

		/**
		 * @param {RTCConfiguration} [config]
		 */
		constructor(config) {
			super(config)
			super.on('icecandidate', event => this.#iceHandler?.(event))
			super.on('datachannel', event => this.#dcHandler?.(event))
			super.on('connectionstatechange', () => this.#connHandler?.())
		}

		/** @returns {((event: RTCPeerConnectionIceEvent) => void) | null} */
		get onicecandidate() { return this.#iceHandler }
		/** @param {((event: RTCPeerConnectionIceEvent) => void) | null} handler */
		set onicecandidate(handler) { this.#iceHandler = handler }

		/** @returns {((event: { channel: RTCDataChannel }) => void) | null} */
		get ondatachannel() { return this.#dcHandler }
		/** @param {((event: { channel: RTCDataChannel }) => void) | null} handler */
		set ondatachannel(handler) { this.#dcHandler = handler }

		/** @returns {(() => void) | null} */
		get onconnectionstatechange() { return this.#connHandler }
		/** @param {(() => void) | null} handler */
		set onconnectionstatechange(handler) { this.#connHandler = handler }
	}
	return {
		RTCPeerConnection: /** @type {typeof RTCPeerConnection} */ (BridgedRTCPeerConnection),
		RTCIceCandidate: mod.RTCIceCandidate,
	}
}

/**
 * @returns {RtcBackend[]} 默认后端顺序：优先 native，失败再纯 JS
 */
function defaultRtcBackends() {
	/** @type {RtcBackend[]} */
	const backends = []
	// Android/Termux：无官方 prebuild，且 Bionic 不能跑 linux-arm64 glibc 包；直接走纯 JS。
	if (process.platform !== 'android')
		backends.push({ id: 'node-datachannel', load: loadNodeDatachannelBackend })
	backends.push({ id: 'node-rtc-connection', load: loadNodeRtcConnectionBackend })
	return backends
}

/**
 * 加载 RTC polyfill（node-datachannel 优先，失败则 node-rtc-connection），并按配置包装 RTCPeerConnection。
 * @param {{ backends?: RtcBackend[] }} [options] 可注入后端列表（测试用）
 * @returns {Promise<LoadedRtcPolyfill>} RTC 构造器
 */
export async function loadNodeRtcPolyfill(options = {}) {
	const backends = options.backends?.length
		? [...options.backends, { id: 'node-rtc-connection', load: loadNodeRtcConnectionBackend }]
		: defaultRtcBackends()
	/** @type {unknown} */
	let lastError = null
	for (const backend of backends) {
		try {
			const mod = await backend.load()
			const { iceLocalHostnamePolicy } = getSignalingRuntimeConfig()
			return {
				RTCPeerConnection: wrapRtcPeerConnectionForIceLocalHostname(
					mod.RTCPeerConnection,
					mod.RTCIceCandidate,
					iceLocalHostnamePolicy,
				),
				RTCIceCandidate: mod.RTCIceCandidate,
				backend: backend.id,
			}
		}
		catch (error) {
			lastError = error
			nodeDebug('p2p:webrtc backend unavailable', {
				backend: backend.id,
				err: String(error?.message ?? error ?? 'unknown-error').replace(/\s+/g, ' ').slice(0, 240),
			})
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'no rtc backend'))
}

/**
 * 绑定 ICE candidate 回调，兼容 onicecandidate / EventEmitter / onIceCandidate.subscribe。
 * @param {RTCPeerConnection} pc 对等连接
 * @param {(event: { candidate: RTCIceCandidate | null }) => void} handler candidate 事件处理器
 * @returns {void}
 */
export function attachIceCandidateListener(pc, handler) {
	pc.onicecandidate = handler
	pc.onIceCandidate?.subscribe?.(candidate =>
		handler({ candidate: candidate ?? null })
	)
}

/**
 * 绑定远端 data channel 回调，兼容 ondatachannel / onDataChannel.subscribe。
 * EventEmitter 后端由 `wrapRtcPeerConnectionForIceLocalHostname` 之外的薄包装或测试 mock 自行把 emit 转到属性。
 * @param {RTCPeerConnection} pc 对等连接
 * @param {(event: { channel: RTCDataChannel }) => void} handler data channel 事件处理器
 * @returns {void}
 */
export function attachDataChannelListener(pc, handler) {
	pc.ondatachannel = handler
	pc.onDataChannel?.subscribe?.(channel => handler({ channel }))
}

/**
 * 等待 data channel 进入 open 或 close 状态，超时则 reject。
 * @param {RTCDataChannel} channel RTC 数据通道
 * @param {'open' | 'close'} eventName 目标状态事件名
 * @param {number} timeoutMs 超时毫秒数
 * @returns {Promise<void>}
 */
export function waitForChannelState(channel, eventName, timeoutMs) {
	return new Promise((resolve, reject) => {
		if (eventName === 'open' && channel.readyState === 'open') {
			resolve()
			return
		}
		if (eventName === 'close' && channel.readyState === 'closed') {
			resolve()
			return
		}
		const timer = setTimeout(() => {
			cleanup()
			reject(new Error(`p2p: data channel ${eventName} timeout after ${timeoutMs}ms`))
		}, timeoutMs)
		/**
		 * 通道状态变化处理函数。
		 * @returns {void}
		 */
		const handler = () => {
			cleanup()
			resolve()
		}
		/**
		 * 移除监听器并清除超时定时器。
		 * @returns {void}
		 */
		const cleanup = () => {
			clearTimeout(timer)
			channel.removeEventListener?.(eventName, handler)
			channel.off?.(eventName, handler)
			channel.removeListener?.(eventName, handler)
			if (eventName === 'open' && channel.onopen === handler) channel.onopen = null
			if (eventName === 'close' && channel.onclose === handler) channel.onclose = null
		}
		channel.addEventListener?.(eventName, handler)
		channel.on?.(eventName, handler)
		if (eventName === 'open') channel.onopen = handler
		if (eventName === 'close') channel.onclose = handler
	})
}

/**
 * 绑定 data channel message 回调（addEventListener / onmessage / EventEmitter / onMessage.subscribe）。
 * @param {RTCDataChannel} channel data channel
 * @param {(data: unknown) => void} handler 消息回调
 * @returns {void}
 */
export function attachChannelMessageListener(channel, handler) {
	channel.addEventListener?.('message', event => handler(event?.data))
	/**
	 * @param {{ data?: unknown }} event message 事件
	 * @returns {void}
	 */
	channel.onmessage = event => handler(event?.data)
	channel.on?.('message', event => handler(event?.data ?? event))
	channel.onMessage?.subscribe(message => handler(message))
}

/**
 * @param {unknown} data 通道原始数据
 * @returns {Uint8Array} 字节
 */
export function dataToBytes(data) {
	return toBytes(data, { allowString: true })
}
