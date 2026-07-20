/**
 * 带 TTL 的 Map：get 时惰性过期；set 时在超上限下先清过期再 LRU 驱逐。
 * @template T
 * @param {number} ttlMs 存活毫秒
 * @param {number} [maxSize=4096] 最大条目（防只写不读时过期项堆积）
 * @returns {{ ttlMs: number, maxSize: number, size: () => number, set: (key: string, value: T) => void, get: (key: string, now?: number) => T | null, clear: () => void }} TTL Map 句柄
 */
export function createTtlMap(ttlMs, maxSize = 4096) {
	const cap = Math.max(1, Math.floor(Number(maxSize) || 4096))
	/** @type {Map<string, { value: T, seenAt: number }>} */
	const map = new Map()

	/**
	 * 删除过期项；若仍满则按插入序驱逐最旧。
	 * @param {number} now 当前时间
	 * @returns {void}
	 */
	function prune(now) {
		for (const [key, entry] of map)
			if (now - entry.seenAt > ttlMs) map.delete(key)
		while (map.size >= cap) {
			const oldest = map.keys().next().value
			map.delete(oldest)
		}
	}

	return {
		ttlMs,
		maxSize: cap,
		/**
		 * @returns {number} 当前条目数（含未 get 的过期项）
		 */
		size: () => map.size,
		/**
		 * @param {string} key 键
		 * @param {T} value 值
		 * @returns {void}
		 */
		set(key, value) {
			const now = Date.now()
			if (map.has(key)) map.delete(key)
			if (map.size >= cap) prune(now)
			map.set(key, { value, seenAt: now })
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
