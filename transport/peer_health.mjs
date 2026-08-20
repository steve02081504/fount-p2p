import { normalizeHex64 } from '../core/hexIds.mjs'
import { emitSafe } from '../utils/emit_safe.mjs'

/**
 * @typedef {{
 *   nodeHash: string
 *   connected: boolean
 *   rttMs: number | null
 *   avgRttMs: number | null
 *   lastSeenAt: number
 *   source: string | null
 * }} PeerHealthEntry
 */

/**
 * 聚合邻居链路健康：在 mesh/link 常态维护期间顺带统计各邻居的 RTT 与可达性。
 * 订阅 registry 的 link up/down，并对每条活跃链路监听 onRtt/onDown。
 * @param {object} registry link registry（onLinkUp / onLinkDown）
 * @returns {{
 *   getPeerHealth: (nodeHash: string) => PeerHealthEntry | null
 *   listPeerHealth: () => PeerHealthEntry[]
 *   onPeerHealth: (listener: (nodeHash: string, entry: PeerHealthEntry) => void) => () => void
 *   stop: () => void
 * }} peer health 聚合器
 */
export function createPeerHealthTracker(registry) {
	/** @type {Map<string, PeerHealthEntry & { _cleanup?: () => void }>} */
	const entries = new Map()
	/** @type {Set<(nodeHash: string, entry: PeerHealthEntry) => void>} */
	const listeners = new Set()

	/**
	 * @param {PeerHealthEntry & { _cleanup?: () => void }} entry 内部记录
	 * @returns {PeerHealthEntry} 对外视图（去掉内部字段）
	 */
	function toPublic(entry) {
		const { _cleanup, ...rest } = entry
		return rest
	}

	/**
	 * 合并补丁并通知订阅方。
	 * @param {string} nodeHash 远端节点 64 hex
	 * @param {Partial<PeerHealthEntry & { _cleanup?: () => void }>} patch 补丁
	 * @returns {void}
	 */
	function update(nodeHash, patch) {
		const existing = entries.get(nodeHash)
		const entry = existing ?? {
			nodeHash,
			connected: false,
			rttMs: null,
			avgRttMs: null,
			lastSeenAt: 0,
			source: null,
		}
		if (patch.connected !== undefined) entry.connected = patch.connected
		if (patch.rttMs !== undefined) entry.rttMs = patch.rttMs
		if (patch.avgRttMs !== undefined) entry.avgRttMs = patch.avgRttMs
		if (patch.lastSeenAt !== undefined) entry.lastSeenAt = patch.lastSeenAt
		if (patch.source !== undefined) entry.source = patch.source
		if (patch._cleanup !== undefined) entry._cleanup = patch._cleanup
		entries.set(nodeHash, entry)
		emitSafe(listeners, nodeHash, toPublic(entry))
	}

	const stopUp = registry.onLinkUp?.((nodeHash, link) => {
		const hash = normalizeHex64(nodeHash)
		if (!hash) return
		const source = link?.providerId ?? null
		const stopRtt = link?.onRtt?.(() => {
			const stats = link.stats?.() ?? {}
			update(hash, {
				rttMs: stats.rttMs ?? null,
				avgRttMs: stats.avgRttMs ?? null,
				lastSeenAt: Date.now(),
			})
		}) ?? null
		const stopDown = link?.onDown?.(() => {
			const current = entries.get(hash)
			current?._cleanup?.()
			update(hash, { connected: false, lastSeenAt: Date.now() })
		}) ?? null
		update(hash, {
			connected: true,
			source,
			_cleanup() {
				stopRtt?.()
				stopDown?.()
				delete entries.get(hash)?._cleanup
			},
		})
	}) ?? null
	const stopDown = registry.onLinkDown?.(nodeHash => {
		const hash = normalizeHex64(nodeHash)
		if (!hash) return
		const current = entries.get(hash)
		current?._cleanup?.()
		update(hash, { connected: false, lastSeenAt: Date.now() })
	}) ?? null

	return {
		/**
		 * @param {string} nodeHash 远端节点 64 hex
		 * @returns {PeerHealthEntry | null} 健康记录；无记录时 null
		 */
		getPeerHealth(nodeHash) {
			const entry = entries.get(normalizeHex64(nodeHash))
			return entry ? toPublic(entry) : null
		},
		/**
		 * @returns {PeerHealthEntry[]} 所有邻居健康记录
		 */
		listPeerHealth() {
			return [...entries.values()].map(toPublic)
		},
		/**
		 * @param {(nodeHash: string, entry: PeerHealthEntry) => void} listener 变化回调
		 * @returns {() => void} 取消订阅
		 */
		onPeerHealth(listener) {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		/**
		 * 停止监听并清空聚合。
		 * @returns {void}
		 */
		stop() {
			stopUp?.()
			stopDown?.()
			for (const entry of entries.values()) entry._cleanup?.()
			entries.clear()
			listeners.clear()
		},
	}
}