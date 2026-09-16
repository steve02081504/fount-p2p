/** 重导出测试身份工厂。 */
export { identity } from '../helpers/identity.mjs'

/**
 * 创建双向内存信令通道对。
 * @returns {{ left: { send: (message: unknown) => void, onRemote: (handler: (message: unknown) => void) => () => void }, right: { send: (message: unknown) => void, onRemote: (handler: (message: unknown) => void) => () => void } }} 左右信令端点
 */
export function createSignalPair() {
	let leftHandler = null
	let rightHandler = null
	const leftQueue = []
	const rightQueue = []
	return {
		left: {
			/**
			 * 向对端发送信令消息。
			 * @param {unknown} message 信令载荷
			 * @returns {void}
			 */
			send(message) {
				queueMicrotask(() => {
					if (rightHandler === null) rightQueue.push(message)
					else rightHandler(message)
				})
			},
			/**
			 * 注册对端消息处理器。
			 * @param {(message: unknown) => void} handler 消息回调
			 * @returns {() => void} 取消注册函数
			 */
			onRemote(handler) {
				leftHandler = handler
				for (const message of leftQueue.splice(0))
					queueMicrotask(() => handler(message))
				return () => { leftHandler = null }
			},
		},
		right: {
			/**
			 * 向对端发送信令消息。
			 * @param {unknown} message 信令载荷
			 * @returns {void}
			 */
			send(message) {
				queueMicrotask(() => {
					if (leftHandler === null) leftQueue.push(message)
					else leftHandler(message)
				})
			},
			/**
			 * 注册对端消息处理器。
			 * @param {(message: unknown) => void} handler 消息回调
			 * @returns {() => void} 取消注册函数
			 */
			onRemote(handler) {
				rightHandler = handler
				for (const message of rightQueue.splice(0))
					queueMicrotask(() => handler(message))
				return () => { rightHandler = null }
			},
		},
	}
}

/**
 * 轮询等待条件成立或超时。
 * @param {() => boolean} predicate 终止条件
 * @param {number} timeoutMs 超时毫秒数
 * @returns {Promise<void>}
 */
export async function waitFor(predicate, timeoutMs) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (predicate()) return
		await new Promise(resolve => setTimeout(resolve, 50))
	}
	throw new Error(`waitFor timeout after ${timeoutMs}ms`)
}
