import { normalizeHex64 } from '../core/hexIds.mjs'
import { listVisibleNodeHashes as discoveryListVisible } from '../discovery/index.mjs'
import { nodeDebug, shortHash } from '../node/log.mjs'
import { applyNetworkHint, loadPeerPoolView, promoteExplorePeer } from '../node/network.mjs'
import { loadReputation } from '../node/reputation_store.mjs'
import { getRoutingProfile } from '../node/routing_profile.mjs'

import { pickMeshEvictionVictim, resolveMeshPoolLimits, selectMeshLinkTargets } from './peer_pool.mjs'
import { loadTransportTunables } from './tunables.mjs'

/** 本机主动关链：不清槽重拨，由下次 tick / 调用方决定。 */
const INTENTIONAL_CLOSE = new Set([
	'budget-evict',
	'manual-close',
	'registry-shutdown',
	'inbound-no-nodehash',
])

/**
 * @param {string | undefined} reason 关链原因
 * @returns {boolean} 是否为本机主动关链（不重拨）
 */
export function isMeshIntentionalClose(reason) {
	return INTENTIONAL_CLOSE.has(String(reason || ''))
}

/**
 * 创建 mesh 保活控制器：扫描可见节点、按 N/K 拨号、稳定探索晋升熟人。
 * @param {object} deps 依赖
 * @param {object} deps.registry link registry（ensureLinkToNode / listLinks / onLinkUp / onLinkDown）
 * @param {boolean} [deps.enabled=true] 是否启用
 * @returns {{ exploreLinkHashes: Set<string>, start: () => void, stop: () => Promise<void> }} mesh 保活控制器
 */
export function createMeshKeepalive(deps) {
	const { registry, enabled = true } = deps
	const tunables = loadTransportTunables()
	/** @type {ReturnType<typeof setInterval> | null} */
	let timer = null
	/** @type {Set<string>} */
	const exploreLinks = new Set()
	/** @type {Map<string, number>} */
	const exploreStableSince = new Map()
	/** @type {(() => void) | null} */
	let stopLinkDown = null
	/** @type {(() => void) | null} */
	let stopLinkUp = null
	/** @type {Promise<void> | null} */
	let tickInflight = null

	/**
	 * 非熟人活跃链记入探索槽（含入站）；熟人则清掉探索标记。
	 * @param {string} nodeHash 对端
	 * @param {string[]} [trustedPeers] 熟人表；省略则读盘
	 * @returns {void}
	 */
	function syncExploreMark(nodeHash, trustedPeers) {
		const hash = normalizeHex64(nodeHash)
		if (!hash) return
		const trusted = trustedPeers ?? loadPeerPoolView().trustedPeers
		if (trusted.includes(hash)) {
			exploreLinks.delete(hash)
			exploreStableSince.delete(hash)
			return
		}
		exploreLinks.add(hash)
	}

	/**
	 * 为拨号腾出空位：优先踢探索。
	 * @param {number} needSlots 需要空位
	 * @param {string[]} trustedPeers 熟人表
	 * @returns {Promise<void>}
	 */
	async function evictExploreForRoom(needSlots, trustedPeers) {
		for (let i = 0; i < needSlots; i++) {
			const connected = registry.listLinks().map(entry => entry.nodeHash)
			const victimHash = pickMeshEvictionVictim(connected, exploreLinks, trustedPeers, () => 0)
			if (!victimHash || trustedPeers.includes(victimHash)) break
			const entry = registry.listLinks().find(item => item.nodeHash === victimHash)
			if (!entry?.link?.close) break
			await entry.link.close('budget-evict')
			exploreLinks.delete(victimHash)
			exploreStableSince.delete(victimHash)
			nodeDebug('p2p:mesh evict', { peer: shortHash(victimHash), reason: 'budget-evict' })
		}
	}

	/**
	 * @returns {Promise<void>}
	 */
	async function tick() {
		if (!enabled) return
		const limits = resolveMeshPoolLimits(getRoutingProfile(), tunables)
		const promoteMs = Math.max(60_000, Number(tunables.meshPromoteStableMs) || 30 * 60_000)
		const scanLimit = Math.max(8, Number(tunables.meshScanLimit) || 64)
		const visible = await discoveryListVisible({ limit: scanLimit })
		for (const hash of visible)
			applyNetworkHint({ nodeHash: hash, source: 'mesh:scan', kind: 'visible', weight: 0.15 })

		const peers = loadPeerPoolView()
		const rep = loadReputation()
		const now = Date.now()
		const connected = new Set(registry.listLinks().map(entry => entry.nodeHash))
		for (const nodeHash of connected)
			syncExploreMark(nodeHash, peers.trustedPeers)

		const targets = selectMeshLinkTargets({
			selfNodeHash: registry.localIdentity.nodeHash,
			trustedPeers: peers.trustedPeers,
			exploreCandidates: [...new Set([...peers.explorePeers, ...visible])],
			hintSources: peers.hintSources,
			limits,
			connectedHashes: connected,
			rep,
			blockedPeers: peers.blockedPeers,
			now,
		})
		const toDial = targets.filter(nodeHash => !connected.has(nodeHash))
		nodeDebug('p2p:mesh tick', {
			N: limits.N,
			K_max: limits.K_max,
			visible: visible.map(hash => shortHash(hash)),
			connected: [...connected].map(hash => shortHash(hash)),
			dial: toDial.map(hash => shortHash(hash)),
		})
		const overflow = connected.size + toDial.length - limits.N
		if (overflow > 0)
			await evictExploreForRoom(overflow, peers.trustedPeers)

		for (const nodeHash of toDial)
			void registry.ensureLinkToNode(nodeHash).then(link => {
				if (link) {
					syncExploreMark(nodeHash, peers.trustedPeers)
					nodeDebug('p2p:mesh dial ok', { peer: shortHash(nodeHash), provider: link.providerId })
				}
				else
					nodeDebug('p2p:mesh dial miss', { peer: shortHash(nodeHash) })
			}).catch(error => {
				nodeDebug('p2p:mesh dial fail', {
					peer: shortHash(nodeHash),
					err: String(error?.message || error),
				})
			})

		const connectedAfter = new Set(registry.listLinks().map(entry => entry.nodeHash))
		for (const nodeHash of connectedAfter) {
			if (peers.trustedPeers.includes(nodeHash)) {
				exploreStableSince.delete(nodeHash)
				continue
			}
			if (!exploreLinks.has(nodeHash)) continue
			const since = exploreStableSince.get(nodeHash) ?? now
			if (!exploreStableSince.has(nodeHash)) exploreStableSince.set(nodeHash, since)
			else if (now - since >= promoteMs) {
				promoteExplorePeer(nodeHash)
				exploreLinks.delete(nodeHash)
				exploreStableSince.delete(nodeHash)
				nodeDebug('p2p:mesh promote', { peer: shortHash(nodeHash) })
			}
		}
		for (const hash of [...exploreStableSince.keys()])
			if (!connectedAfter.has(hash)) exploreStableSince.delete(hash)
	}

	/**
	 * @returns {Promise<void>}
	 */
	function runTick() {
		if (tickInflight) return tickInflight
		tickInflight = tick().catch(error => {
			nodeDebug('p2p:mesh tick fail', { err: String(error?.message || error) })
		}).finally(() => { tickInflight = null })
		return tickInflight
	}

	return {
		/** @returns {Set<string>} 探索链路集合（trim 时优先驱逐） */
		exploreLinkHashes: exploreLinks,
		/**
		 * 启动 mesh 扫描 / 拨号 / 晋升循环。
		 * @returns {void}
		 */
		start() {
			if (!enabled || timer) return
			nodeDebug('p2p:mesh start', { self: shortHash(registry.localIdentity?.nodeHash) })
			stopLinkUp = registry.onLinkUp?.(nodeHash => {
				syncExploreMark(nodeHash)
			}) ?? null
			stopLinkDown = registry.onLinkDown((nodeHash, reason) => {
				const hash = normalizeHex64(nodeHash)
				exploreLinks.delete(hash)
				exploreStableSince.delete(hash)
				nodeDebug('p2p:mesh link down', { peer: shortHash(hash), reason })
				// 主动关链不立刻补洞（避免 budget-evict 刚踢又连）；意外断链用 tick 按 N/K 重选，而非粘住原对端。
				if (isMeshIntentionalClose(reason)) return
				void runTick()
			})
			void runTick()
			timer = setInterval(() => { void runTick() }, Math.max(15_000, Number(tunables.meshKeepaliveIntervalMs) || 60_000))
			timer.unref?.()
		},
		/**
		 * 停止保活并清空探索标记。
		 * @returns {Promise<void>}
		 */
		async stop() {
			if (timer) { clearInterval(timer); timer = null }
			stopLinkUp?.()
			stopLinkUp = null
			stopLinkDown?.()
			stopLinkDown = null
			exploreLinks.clear()
			exploreStableSince.clear()
			if (tickInflight) await tickInflight.catch(() => { })
		},
	}
}
