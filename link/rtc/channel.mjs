/**
 * 等待 data channel 进入 open 或 close 状态，超时则 reject。
 * @param {RTCDataChannel} channel RTC 数据通道
 * @param {'open' | 'close'} eventName 目标状态事件名
 * @param {number} timeoutMs 超时毫秒数
 * @returns {Promise<void>}
 */
export function waitForChannelState(channel, eventName, timeoutMs) {
	return new Promise((resolve, reject) => {
		if (eventName === 'open' && channel.readyState === 'open') return resolve()
		if (eventName === 'close' && channel.readyState === 'closed') return resolve()
		const timer = setTimeout(() => {
			cleanup()
			reject(new Error(`p2p: data channel ${eventName} timeout after ${timeoutMs}ms`))
		}, timeoutMs)
		const handler = () => {
			cleanup()
			resolve()
		}
		const cleanup = () => {
			clearTimeout(timer)
			if (eventName === 'open' && channel.onopen === handler) channel.onopen = null
			if (eventName === 'close' && channel.onclose === handler) channel.onclose = null
		}
		if (eventName === 'open') channel.onopen = handler
		else channel.onclose = handler
	})
}
