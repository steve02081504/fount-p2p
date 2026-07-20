import { Buffer } from 'node:buffer'

import { canonicalStringify } from '../core/canonical_json.mjs'
import { isHex64, normalizeHex64 } from '../core/hexIds.mjs'
import { isPlainObject } from '../wire/ingress.mjs'
import { normalizePartpath } from '../wire/part_invoke.mjs'
import partQueryTunables from '../wire/part_query.tunables.json' with { type: 'json' }

/**
 * @typedef {{
 *   requestId: string
 *   originNodeHash: string
 *   partpath: string
 *   kind: string
 *   query: unknown
 *   ttl: number
 *   budget: { maxHits: number }
 * }} PartQueryReq
 */

/**
 * @typedef {{
 *   requestId: string
 *   fromNodeHash: string
 *   rows: unknown[]
 * }} PartQueryRes
 */

/**
 * @param {unknown} value 任意 JSON
 * @returns {number} UTF-8 序列化字节数；不可序列化时 Infinity
 */
export function measureJsonBytes(value) {
	try {
		return Buffer.byteLength(JSON.stringify(value), 'utf8')
	}
	catch {
		return Number.POSITIVE_INFINITY
	}
}

/**
 * @param {unknown} budget 请求预算
 * @param {number} [maxHits=partQueryTunables.maxHits] 上限
 * @returns {{ maxHits: number }} 钳制后的预算
 */
export function clampPartQueryBudget(budget, maxHits = partQueryTunables.maxHits) {
	const cap = Math.max(1, Math.floor(Number(maxHits) || partQueryTunables.maxHits))
	const raw = isPlainObject(budget) ? Number(budget.maxHits) : NaN
	const hits = Number.isFinite(raw) ? Math.floor(raw) : cap
	return { maxHits: Math.max(1, Math.min(cap, hits)) }
}

/**
 * @param {unknown} ttl 跳数预算
 * @param {number} [maxTtl=partQueryTunables.maxTtl] 上限
 * @returns {number | null} 钳制后的 ttl；非法为 null
 */
export function clampPartQueryTtl(ttl, maxTtl = partQueryTunables.maxTtl) {
	const cap = Math.max(1, Math.floor(Number(maxTtl) || partQueryTunables.maxTtl))
	const n = Math.floor(Number(ttl))
	if (!Number.isFinite(n) || n < 1) return null
	return Math.min(cap, n)
}

/**
 * @param {unknown} rows 行数组
 * @param {number} maxHits 条数上限
 * @param {number} [maxRowsBytes=partQueryTunables.maxRowsBytes] 总尺寸上限
 * @returns {unknown[] | null} 通过校验的 rows；失败 null
 */
export function clampPartQueryRows(rows, maxHits, maxRowsBytes = partQueryTunables.maxRowsBytes) {
	if (!Array.isArray(rows)) return null
	const limited = rows.slice(0, Math.max(0, Math.floor(Number(maxHits) || 0)))
	if (measureJsonBytes(limited) > maxRowsBytes) return null
	return limited
}

/** requestId 上限（randomUUID 36 字符；防超长键灌爆 dedupe/pending 表） */
const REQUEST_ID_MAX_LENGTH = 128

/**
 * @param {unknown} value 原始 requestId
 * @returns {string | null} 修剪后的 requestId；非法 null
 */
function normalizeRequestId(value) {
	const requestId = String(value || '').trim()
	if (!requestId || requestId.length > REQUEST_ID_MAX_LENGTH) return null
	return requestId
}

/**
 * @param {unknown} value 入站 req
 * @param {typeof partQueryTunables} [tunables] 可调参数
 * @returns {PartQueryReq | null} 校验通过的 req
 */
export function parsePartQueryReq(value, tunables = partQueryTunables) {
	if (!isPlainObject(value)) return null
	const requestId = normalizeRequestId(value.requestId)
	if (!requestId) return null
	const originNodeHash = normalizeHex64(value.originNodeHash)
	if (!isHex64(originNodeHash)) return null
	const partpath = normalizePartpath(value.partpath)
	if (!partpath) return null
	const kind = String(value.kind || '').trim()
	if (!kind) return null
	if (!Object.prototype.hasOwnProperty.call(value, 'query')) return null
	if (measureJsonBytes(value.query) > (tunables.maxQueryBytes ?? 2048)) return null
	const ttl = clampPartQueryTtl(value.ttl, tunables.maxTtl)
	if (!ttl) return null
	const budget = clampPartQueryBudget(value.budget, tunables.maxHits)
	return {
		requestId,
		originNodeHash,
		partpath,
		kind,
		query: value.query,
		ttl,
		budget,
	}
}

/**
 * @param {unknown} value 入站 res
 * @param {typeof partQueryTunables} [tunables] 可调参数
 * @returns {PartQueryRes | null} 校验通过的 res
 */
export function parsePartQueryRes(value, tunables = partQueryTunables) {
	if (!isPlainObject(value)) return null
	const requestId = normalizeRequestId(value.requestId)
	if (!requestId) return null
	const fromNodeHash = normalizeHex64(value.fromNodeHash)
	if (!isHex64(fromNodeHash)) return null
	const rows = clampPartQueryRows(value.rows, tunables.maxHits, tunables.maxRowsBytes)
	if (!rows) return null
	return { requestId, fromNodeHash, rows }
}

/**
 * @param {unknown} partpath part 路径
 * @param {unknown} kind 查询标签
 * @param {unknown} query 不透明查询
 * @returns {string | null} 规范化三元组的缓存材料；非法 null
 */
export function normalizePartQueryCacheMaterial(partpath, kind, query) {
	const path = normalizePartpath(partpath)
	const k = String(kind || '').trim()
	if (!path || !k) return null
	if (measureJsonBytes(query) > partQueryTunables.maxQueryBytes) return null
	try {
		return canonicalStringify({ partpath: path, kind: k, query })
	}
	catch {
		return null
	}
}
