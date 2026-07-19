import { normalizeHex64 } from '../core/hexIds.mjs'
import { normalizeTcpPort } from '../core/tcp_port.mjs'
import { createTtlMap } from '../utils/ttl_map.mjs'

/** LAN peer hint 存活时间。 */
export const LAN_PEER_HINT_TTL_MS = 5 * 60_000

/** @type {ReturnType<typeof createTtlMap<{ host: string, port: number }>>} */
const hints = createTtlMap(LAN_PEER_HINT_TTL_MS)

/**
 * 记录 LAN 上观察到的 nodeHash → host:port。
 * @param {string} nodeHash 节点 64 hex
 * @param {{ host: string, port: number }} endpoint 端点
 * @returns {void}
 */
export function noteLanPeerHint(nodeHash, endpoint) {
	const hash = normalizeHex64(nodeHash)
	const host = String(endpoint?.host || '').trim()
	const port = normalizeTcpPort(endpoint?.port)
	if (!hash || !host || !port) return
	hints.set(hash, { host, port })
}

/**
 * 查询未过期的 LAN peer hint。
 * @param {string} nodeHash 节点 64 hex
 * @param {number} [now=Date.now()] 当前时间（测试可注入）
 * @returns {{ host: string, port: number } | null} hint 或 null
 */
export function getLanPeerHint(nodeHash, now = Date.now()) {
	const hash = normalizeHex64(nodeHash)
	if (!hash) return null
	return hints.get(hash, now)
}

/**
 * 清空全部 LAN peer hints（测试用）。
 * @returns {void}
 */
export function clearLanPeerHints() {
	hints.clear()
}
