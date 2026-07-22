import { normalizeHex64 } from '../core/hexIds.mjs'
import { normalizeTcpPort } from '../core/tcp_port.mjs'
import { createTtlMap } from '../utils/ttl_map.mjs'

/** LAN peer hint 存活时间。 */
export const LAN_PEER_HINT_TTL_MS = 5 * 60_000

/** 单 peer 保留的 endpoint 上限。 */
const MAX_ENDPOINTS = 8

/** @type {ReturnType<typeof createTtlMap<{ endpoints: { host: string, port: number }[] }>>} */
const hints = createTtlMap(LAN_PEER_HINT_TTL_MS)

/**
 * 记录 LAN 上观察到的 nodeHash → host:port。
 * 最新写入排在最前（dial / getLanPeerHint 优先用新观测）。
 * @param {string} nodeHash 节点 64 hex
 * @param {{ host: string, port: number }} endpoint 端点
 * @returns {void}
 */
export function noteLanPeerHint(nodeHash, endpoint) {
	const hash = normalizeHex64(nodeHash)
	const host = String(endpoint?.host || '').trim()
	const port = normalizeTcpPort(endpoint?.port)
	if (!hash || !host || !port) return
	const existing = hints.get(hash)?.endpoints ?? []
	const next = existing.filter(item => !(item.host === host && item.port === port))
	next.unshift({ host, port })
	hints.set(hash, { endpoints: next.slice(0, MAX_ENDPOINTS) })
}

/**
 * 查询未过期的首个 LAN peer hint（最新观测）。
 * @param {string} nodeHash 节点 64 hex
 * @param {number} [now=Date.now()] 当前时间（测试可注入）
 * @returns {{ host: string, port: number } | null} hint 或 null
 */
export function getLanPeerHint(nodeHash, now = Date.now()) {
	return listLanPeerHints(nodeHash, now)[0] ?? null
}

/**
 * 查询未过期的全部 LAN peer hint（最新在前）。
 * @param {string} nodeHash 节点 64 hex
 * @param {number} [now=Date.now()] 当前时间（测试可注入）
 * @returns {{ host: string, port: number }[]} hint 列表
 */
export function listLanPeerHints(nodeHash, now = Date.now()) {
	const hash = normalizeHex64(nodeHash)
	if (!hash) return []
	return hints.get(hash, now)?.endpoints ?? []
}

/**
 * 清空全部 LAN peer hints（测试用）。
 * @returns {void}
 */
export function clearLanPeerHints() {
	hints.clear()
}
