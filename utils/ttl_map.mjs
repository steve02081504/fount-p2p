/**
 * 带 TTL 的 Map：get 时惰性过期删除。
 * @template T
 * @param {number} ttlMs 存活毫秒
 * @returns {{ ttlMs: number, set: (key: string, value: T) => void, get: (key: string, now?: number) => T | null, clear: () => void }} TTL Map 句柄
 */
export function createTtlMap(ttlMs) {
	/** @type {Map<string, { value: T, seenAt: number }>} */
	const map = new Map()
	return {
		ttlMs,
		/**
		 * @param {string} key 键
		 * @param {T} value 值
		 * @returns {void}
		 */
		set(key, value) {
			map.set(key, { value, seenAt: Date.now() })
		},
		/**
		 * @param {string} key 键
		 * @param {number} [now=Date.now()] 当前时间（测试可注入）
		 * @returns {T | null} 未过期值，否则 null
		 */
		get(key, now = Date.now()) {
			const entry = map.get(key)
			if (!entry) return null
			if (now - entry.seenAt > ttlMs) {
				map.delete(key)
				return null
			}
			return entry.value
		},
		/**
		 * @returns {void}
		 */
		clear() {
			map.clear()
		},
	}
}
