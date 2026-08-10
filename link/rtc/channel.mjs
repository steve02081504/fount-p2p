/**
 * 等待 data channel 进入 open 或 close 状态，超时则 reject。
 * 同一 channel 可并发等待：新订阅链式调用已有 onopen/onclose，cleanup 只摘掉自身。
 * @param {RTCDataChannel} channel RTC 数据通道
 * @param {'open' | 'close'} eventName 目标状态事件名
 * @param {number} timeoutMs 超时毫秒数
 * @returns {Promise<void>}
 */
export function waitForChannelState(channel, eventName, timeoutMs) {
	return new Promise((resolve, reject) => {
		if (eventName === 'open' && channel.readyState === 'open') return resolve()
		if (eventName === 'close' && channel.readyState === 'closed') return resolve()
		const eventHandlerProperty = eventName === 'open' ? 'onopen' : 'onclose'
		const previousHandler = channel[eventHandlerProperty]
		let active = true
		const timer = setTimeout(() => {
			cleanup()
			reject(new Error(`p2p: data channel ${eventName} timeout after ${timeoutMs}ms`))
		}, timeoutMs)
		const cleanup = () => {
			if (!active) return
			active = false
			clearTimeout(timer)
			if (channel[eventHandlerProperty] === chained) channel[eventHandlerProperty] = previousHandler
		}
		const chained = (...eventArguments) => {
			previousHandler?.(...eventArguments)
			if (!active) return
			cleanup()
			resolve()
		}
		channel[eventHandlerProperty] = chained
	})
}
