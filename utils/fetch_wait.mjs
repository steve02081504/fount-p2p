/**
 * 有界 pending fetch 等待表（chunk / manifest 等入站响应槽）。
 * @template T
 * @param {{ maxSize: number }} options 容量
 * @returns {{
 *   pending: Map<string, { expectedKey: string, timer: ReturnType<typeof setTimeout>, finish: (value: T | null | Error) => void, handle: { done: Promise<T | null>, cancel: () => void }, options: Record<string, unknown> }>,
 *   register: (key: string, expectedKey: string, timeoutMs: number, options?: { rejectOnTimeout?: boolean }) => { done: Promise<T | null>, cancel: () => void },
 *   peek: (key: string) => { expectedKey: string, timer: ReturnType<typeof setTimeout>, finish: (value: T | null | Error) => void, handle: { done: Promise<T | null>, cancel: () => void }, options: Record<string, unknown> } | undefined,
 *   settle: (key: string, value: T | null | Error) => boolean,
 * }} 等待表 API
 */
export function createFetchWaitTable({ maxSize }) {
	/** @type {Map<string, { expectedKey: string, timer: ReturnType<typeof setTimeout>, finish: (value: T | null | Error) => void, handle: { done: Promise<T | null>, cancel: () => void }, options: Record<string, unknown> }>} */
	const pending = new Map()

	/**
	 * @param {string} key 等待键
	 * @param {T | null | Error} value 结果或错误
	 * @returns {boolean} 是否命中并完成
	 */
	function settle(key, value) {
		const entry = pending.get(key)
		if (!entry) return false
		clearTimeout(entry.timer)
		pending.delete(key)
		entry.finish(value)
		return true
	}

	return {
		pending,

		/**
		 * @param {string} key 唯一等待键
		 * @param {string} expectedKey 期望匹配键
		 * @param {number} timeoutMs 超时
		 * @param {{ rejectOnTimeout?: boolean }} [options] 超时是否 reject
		 * @returns {{ done: Promise<T | null>, cancel: () => void }} 等待句柄
		 */
		register(key, expectedKey, timeoutMs, options = {}) {
			if (!key)
				return {
					done: Promise.resolve(null),
					/** @returns {void} */
					cancel: () => { },
				}

			const existing = pending.get(key)
			if (existing) return existing.handle

			if (pending.size >= maxSize)
				return {
					done: Promise.resolve(null),
					/** @returns {void} */
					cancel: () => { },
				}

			/** @type {(value: T | null | Error) => void} */
			let finish
			const done = new Promise((resolve, reject) => {
				/**
				 * @param {T | null | Error} value 完成值或错误
				 * @returns {void}
				 */
				finish = value => {
					if (value instanceof Error) reject(value)
					else resolve(value)
				}
			})

			const timer = setTimeout(() => {
				pending.delete(key)
				if (options.rejectOnTimeout) finish(new Error('fetch timeout'))
				else finish(null)
			}, timeoutMs)

			/** @type {{ done: Promise<T | null>, cancel: () => void }} */
			const handle = {
				done,
				/** @returns {void} 取消等待 */
				cancel: () => settle(key, null),
			}
pending.set(key, { expectedKey, timer, finish, handle, options })
		return handle
		},

		/**
		 * 只读查看，不移除。
		 * @param {string} key 等待键
		 * @returns {{ expectedKey: string, timer: ReturnType<typeof setTimeout>, finish: (value: T | null | Error) => void, handle: { done: Promise<T | null>, cancel: () => void } } | undefined} 等待条目
		 */
		peek(key) {
			return pending.get(key)
		},

		settle,
	}
}
