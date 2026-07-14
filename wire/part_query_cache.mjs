import { sha256Hex } from '../crypto/crypto.mjs'
import { normalizePartQueryCacheMaterial } from '../schemas/part_query.mjs'
import { createLruMap } from '../utils/lru.mjs'

import partQueryTunables from './part_query.tunables.json' with { type: 'json' }

/**
 * @typedef {{ rows: unknown[], storedAt: number }} PartQueryCacheEntry
 */

/**
 * @param {string} partpath part 路径
 * @param {string} kind 查询标签
 * @param {unknown} query 不透明查询
 * @returns {string | null} sha256 hex 缓存键
 */
export function partQueryCacheKey(partpath, kind, query) {
	const material = normalizePartQueryCacheMaterial(partpath, kind, query)
	if (!material) return null
	return sha256Hex(material)
}

/**
 * LRU + TTL 中继缓存（未验证线索；发起端仍需验签复核）。
 * @param {{ maxKeys?: number, ttlMs?: number, maxHits?: number }} [options] 容量 / TTL / 单键 rows 上限
 * @returns {{
 *   get: (partpath: string, kind: string, query: unknown, now?: number) => unknown[] | null
 *   set: (partpath: string, kind: string, query: unknown, rows: unknown[], now?: number) => void
 *   clear: () => void
 *   readonly size: number
 * }} 缓存 API
 */
export function createPartQueryCache(options = {}) {
	const maxKeys = Math.max(1, Math.floor(Number(options.maxKeys) || partQueryTunables.cacheMaxKeys))
	const ttlMs = Math.max(1, Math.floor(Number(options.ttlMs) || partQueryTunables.cacheTtlMs))
	const maxHits = Math.max(1, Math.floor(Number(options.maxHits) || partQueryTunables.maxHits))
	/** @type {ReturnType<typeof createLruMap<string, PartQueryCacheEntry>>} */
	const map = createLruMap(maxKeys)

	/**
	 * @param {number} [now=Date.now()] 当前时间
	 * @returns {void}
	 */
	const sweep = (now = Date.now()) => {
		for (const [key, entry] of map)
			if (now - entry.storedAt >= ttlMs) map.delete(key)
	}

	return {
		/**
		 * @param {string} partpath part 路径
		 * @param {string} kind 查询标签
		 * @param {unknown} query 查询体
		 * @param {number} [now=Date.now()] 当前时间
		 * @returns {unknown[] | null} 未过期 rows
		 */
		get(partpath, kind, query, now = Date.now()) {
			const key = partQueryCacheKey(partpath, kind, query)
			if (!key) return null
			const entry = map.get(key)
			if (!entry) return null
			if (now - entry.storedAt >= ttlMs) {
				map.delete(key)
				return null
			}
			map.touch(key, entry)
			return entry.rows.slice()
		},

		/**
		 * @param {string} partpath part 路径
		 * @param {string} kind 查询标签
		 * @param {unknown} query 查询体
		 * @param {unknown[]} rows 聚合 rows
		 * @param {number} [now=Date.now()] 当前时间
		 * @returns {void}
		 */
		set(partpath, kind, query, rows, now = Date.now()) {
			const key = partQueryCacheKey(partpath, kind, query)
			if (!key || !Array.isArray(rows)) return
			sweep(now)
			map.touch(key, {
				rows: rows.slice(0, maxHits),
				storedAt: now,
			})
		},

		/** @returns {void} */
		clear() {
			map.clear()
		},

		/** @returns {number} 当前条目数 */
		get size() {
			return map.size
		},
	}
}

/** 进程内默认中继缓存 */
export const partQueryCache = createPartQueryCache()
