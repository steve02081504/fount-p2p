/**
 * 联邦/房间陈旧 peer 自愈修剪可观测性：进程内计数器 + 近期记录 + debug_logs。
 *
 * 无回退行为——仅在发生处记录异常「身份映射滞后于活跃连接」
 * （群/房间 + peerId + nodeHash），以便追踪 onPeerLeave 遗漏。
 * 计数通过 catchup stats 暴露给测试；磁盘记录可在 debug_logs/ 下 grep。
 */
import { debugLog } from '../utils/debug_log.mjs'

/** @type {Map<string, number>} scopeId → 累计修剪次数 */
const pruneCounts = new Map()
/** @type {Array<{ ts: number, scope: string, peerId: string, nodeHash: string | null, meta?: object }>} */
const recent = []
const RECENT_CAP = 200

/**
 * 记录一批陈旧 peer 修剪。
 * @param {string} scope 计数器 scope（群 id / 房间标签）
 * @param {Array<{ peerId: string, remoteNodeHash?: string }>} staleEntries 被修剪条目
 * @param {object} [meta] 写入磁盘记录的额外上下文（partitionId / room）
 * @returns {void}
 */
export function recordStalePeerPrune(scope, staleEntries, meta = {}) {
	if (!staleEntries?.length) return
	pruneCounts.set(scope, (pruneCounts.get(scope) || 0) + staleEntries.length)
	const ts = Date.now()
	const lines = []
	for (const { peerId, remoteNodeHash } of staleEntries) {
		const record = { ts, scope, peerId, nodeHash: remoteNodeHash || null, ...meta }
		recent.push(record)
		lines.push(JSON.stringify(record))
	}
	while (recent.length > RECENT_CAP) recent.shift()
	void debugLog('federation_stale_peer', `${lines.join('\n')}\n`).catch(() => { /* best-effort observability */ })
}

/**
 * @param {string} scope 计数器 scope
 * @returns {number} 该 scope 累计修剪次数
 */
export function getStalePeerPruneCount(scope) {
	return pruneCounts.get(scope) || 0
}

/**
 * @returns {Array<{ ts: number, scope: string, peerId: string, nodeHash: string | null, meta?: object }>} 近期修剪记录
 */
export function getRecentStalePeerPrunes() {
	return [...recent]
}
