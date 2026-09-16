/**
 * In-flight 去重表：同 key 复用并 touch 到队尾；队满时仅淘汰「已超过 baseTimeout」的队首。
 * 双窗口：size >= maxSize 且 entry 年龄 >= baseTimeoutMs 才 cancel。
 *
 * @template T
 * @param {{ maxSize: number, baseTimeoutMs: number, now?: () => number }} options 容量与基础超时
 * @returns {{
 *   size: () => number,
 *   has: (key: string) => boolean,
 *   acquire: (key: string, start: () => { done: Promise<T>, cancel: () => void }) => Promise<T> | null,
 *   clear: () => void,
 * }} 表句柄
 */
export function createInflightTable(options) {
	const maxSize = Math.max(1, Math.floor(Number(options.maxSize) || 1))
	const baseTimeoutMs = Math.max(0, Number(options.baseTimeoutMs) || 0)
	const now = options.now || Date.now

	/** @type {Map<string, { done: Promise<T>, cancel: () => void, startedAt: number }>} */
	const map = new Map()

	/**
	 * 队满时从队首取消已超时项。
	 * @returns {void}
	 */
	function pruneAgedOverCap() {
		const t = now()
		while (map.size >= maxSize) {
			const oldestKey = map.keys().next().value
			const entry = map.get(oldestKey)
			if (!entry || t - entry.startedAt < baseTimeoutMs) break
			map.delete(oldestKey)
			entry.cancel()
		}
	}

	/**
	 * @param {string} key 逻辑键
	 * @param {{ done: Promise<T>, cancel: () => void, startedAt: number }} entry 条目
	 * @returns {void}
	 */
	function track(key, entry) {
		entry.done.finally(() => {
			if (map.get(key) === entry) map.delete(key)
		})
		map.set(key, entry)
	}

	return {
		/**
		 * @returns {number} 当前 in-flight 数
		 */
		size: () => map.size,
		/**
		 * @param {string} key 逻辑键
		 * @returns {boolean} 是否在飞
		 */
		has: key => map.has(key),
		/**
		 * 复用或启动；队满且无法淘汰超时项时返回 null（拒绝新开）。
		 * @param {string} key 逻辑键
		 * @param {() => { done: Promise<T>, cancel: () => void }} start 仅在未命中时调用
		 * @returns {Promise<T> | null} 共享 Promise，或拒绝新开
		 */
		acquire(key, start) {
			const existing = map.get(key)
			if (existing) {
				map.delete(key)
				map.set(key, existing)
				pruneAgedOverCap()
				return existing.done
			}

			pruneAgedOverCap()
			if (map.size >= maxSize) return null

			const started = start()
			const entry = {
				done: started.done,
				cancel: started.cancel,
				startedAt: now(),
			}
			track(key, entry)
			return entry.done
		},
		/**
		 * 取消全部并清空（测试用）。
		 * @returns {void}
		 */
		clear() {
			for (const entry of map.values()) entry.cancel()
			map.clear()
		},
	}
}
