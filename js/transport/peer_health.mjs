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
 *   start: () => void
 *   stop: () => void
 * }} peer health 聚合器
 */
export function createPeerHealthTracker(registry) {
	/** @type {Map<string, PeerHealthEntry>} */
	const entries = new Map()
	/** @type {Map<string, () => void>} 每条链路在 registry/link 上的取消订阅回调 */
	const cleanups = new Map()
	/** @type {Set<(nodeHash: string, entry: PeerHealthEntry) => void>} */
	const listeners = new Set()
	/** @type {(() => void) | null} registry link up 退订 */
	let stopUp = null
	/** @type {(() => void) | null} registry link down 退订 */
	let stopDown = null

	/**
	 * 合并补丁并通知订阅方。
	 * @param {string} nodeHash 远端节点 64 hex
	 * @param {Partial<PeerHealthEntry>} patch 补丁
	 * @returns {void}
	 */
	function update(nodeHash, patch) {
		const entry = entries.get(nodeHash) ?? {
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
		entries.set(nodeHash, entry)
		emitSafe(listeners, nodeHash, entry)
	}

	/**
	 * 订阅 registry 的链路事件（幂等）。
	 * `stop()` 之后可用它重新挂上监听：registry 的 link up/down 桶在 shutdown 时不会被清空，
	 * 所以重启运行时后健康记录能自然恢复。
	 * @returns {void}
	 */
	function start() {
		if (stopUp) return
		stopUp = registry.onLinkUp?.((nodeHash, link) => {
			if (!nodeHash) return
			const stopRtt = link?.onRtt?.(() => {
				const stats = link.stats?.() ?? {}
				update(nodeHash, {
					rttMs: stats.rttMs ?? null,
					avgRttMs: stats.avgRttMs ?? null,
					lastSeenAt: Date.now(),
				})
			}) ?? null
			const stopLinkDown = link?.onDown?.(() => {
				cleanups.get(nodeHash)?.()
				cleanups.delete(nodeHash)
				update(nodeHash, { connected: false, lastSeenAt: Date.now() })
			}) ?? null
			update(nodeHash, {
				connected: true,
				source: link?.providerId ?? null,
				lastSeenAt: Date.now(),
			})
			cleanups.set(nodeHash, () => {
				stopRtt?.()
				stopLinkDown?.()
			})
		}) ?? null
		stopDown = registry.onLinkDown?.(nodeHash => {
			if (!nodeHash) return
			cleanups.get(nodeHash)?.()
			cleanups.delete(nodeHash)
			update(nodeHash, { connected: false, lastSeenAt: Date.now() })
		}) ?? null
	}

	start()

	return {
		/**
		 * @param {string} nodeHash 远端节点 64 hex
		 * @returns {PeerHealthEntry | null} 健康记录；无记录时 null
		 */
		getPeerHealth(nodeHash) {
			return entries.get(nodeHash) ?? null
		},
		/**
		 * @returns {PeerHealthEntry[]} 所有邻居健康记录
		 */
		listPeerHealth() {
			return [...entries.values()]
		},
		/**
		 * @param {(nodeHash: string, entry: PeerHealthEntry) => void} listener 变化回调
		 * @returns {() => void} 取消订阅
		 */
		onPeerHealth(listener) {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		start,
		/**
		 * 停止监听并清空聚合（listen 订阅保留，listeners 订阅者保留）。
		 * @returns {void}
		 */
		stop() {
			stopUp?.()
			stopDown?.()
			stopUp = null
			stopDown = null
			for (const cleanup of cleanups.values()) cleanup()
			cleanups.clear()
			entries.clear()
		},
	}
}
