import process from 'node:process'

import { toBytes } from '../core/bytes_codec.mjs'
import { getSignalingRuntimeConfig } from '../node/instance.mjs'
import { wrapRtcPeerConnectionForIceLocalHostname } from '../transport/rtc_ice_local_hostname.mjs'

/**
 * 注册进程退出时销毁 libdatachannel 全部原生资源（仅一次）。
 * libdatachannel 的原生线程在 pc.close() 后仍需时间回收；进程退出时若原生资源未同步销毁，
 * Windows 上会触发堆损坏（退出码 0xC0000374）。
 */
const { cleanup = undefined } = await import('node-datachannel').catch(() => ({}))
process.on('exit', () => {
	try { cleanup?.() } catch { /* already torn down */ }
})

/**
 * 加载 node-datachannel polyfill，并按配置包装 RTCPeerConnection。
 * @returns {Promise<{ RTCPeerConnection: typeof RTCPeerConnection, RTCIceCandidate: typeof RTCIceCandidate }>} RTC 构造器
 */
export async function loadNodeRtcPolyfill() {
	const mod = await import('node-datachannel/polyfill')
	const { iceLocalHostnamePolicy } = getSignalingRuntimeConfig()
	return {
		RTCPeerConnection: wrapRtcPeerConnectionForIceLocalHostname(mod.RTCPeerConnection, mod.RTCIceCandidate, iceLocalHostnamePolicy),
		RTCIceCandidate: mod.RTCIceCandidate,
	}
}

/**
 * 绑定 ICE candidate 回调，兼容 onicecandidate 与 onIceCandidate.subscribe。
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
 * 绑定远端 data channel 回调，兼容 ondatachannel 与 onDataChannel.subscribe。
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
			if (eventName === 'open' && channel.onopen === handler) channel.onopen = null
			if (eventName === 'close' && channel.onclose === handler) channel.onclose = null
		}
		channel.addEventListener?.(eventName, handler)
		if (eventName === 'open') channel.onopen = handler
		if (eventName === 'close') channel.onclose = handler
	})
}

/**
 * 绑定 data channel message 回调（addEventListener / onmessage / onMessage.subscribe）。
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
	channel.onMessage?.subscribe(message => handler(message))
}

/**
 * @param {unknown} data 通道原始数据
 * @returns {Uint8Array} 字节
 */
export function dataToBytes(data) {
	return toBytes(data, { allowString: true })
}
