/**
 * 连接池纯计算：
 * - 群联邦稀疏拨号：trustedSlots + exploreSlots（groupSettings）
 * - 节点 mesh 保活：N / K_max（routing profile + transport tunables）
 * 不含文件 I/O；I/O 由调用方注入。
 */

import { compareHex64Asc } from '../core/hexIds.mjs'
import { loadPeerPoolView, mergeNetworkPeerPools } from '../node/network.mjs'
import { loadReputation } from '../node/reputation_store.mjs'
import { isQuarantinedPure } from '../reputation/engine.mjs'
import { clampReputationScore } from '../reputation/math.mjs'
import { shuffleInPlace } from '../utils/shuffle.mjs'

/**
 * 解析联邦池槽位参数（从 groupSettings 读取，含低功耗缩减）。
 * @param {object | undefined} groupSettings 群设置
 * @returns {{
 *   trustedSlots: number,
 *   exploreSlots: number,
 *   maxPeers: number,
 *   gossipTtl: number,
 *   wantIdsBudget: number,
 *   batterySaver: boolean,
 * }} 解析后的联邦池参数
 */
export function resolveFederationPoolLimits(groupSettings = {}) {
	const battery = !!groupSettings.batterySaver
	const trustedSlots = battery
		? 2
		: Math.max(1, Math.min(32, Number(groupSettings.trustedPeerSlots) || 8))
	const exploreSlots = battery
		? 1
		: Math.max(0, Math.min(16, Number(groupSettings.explorePeerSlots) || 4))
	const maxPeersRaw = Number(groupSettings.maxPeers)
	const maxPeers = Number.isFinite(maxPeersRaw) && maxPeersRaw > 0
		? Math.min(64, Math.floor(maxPeersRaw))
		: Math.min(64, Math.max(trustedSlots + exploreSlots, 24))
	let trustedOut = trustedSlots
	let exploreOut = exploreSlots
	if (trustedOut + exploreOut > maxPeers) {
		trustedOut = Math.min(trustedOut, maxPeers)
		exploreOut = Math.min(exploreOut, Math.max(0, maxPeers - trustedOut))
	}
	const gossipTtl = Math.max(0, Math.min(8, Number.isFinite(Number(groupSettings.gossipTtl)) ? Number(groupSettings.gossipTtl) : 2))
	const wantIdsBudget = Math.max(4, Math.min(128, Number(groupSettings.wantIdsBudget) || 16))
	return {
		trustedSlots: trustedOut,
		exploreSlots: exploreOut,
		maxPeers,
		gossipTtl,
		wantIdsBudget,
		batterySaver: battery,
	}
}

/**
 * @param {string} nodeId 节点 id
 * @param {{ byNodeHash?: Record<string, { score?: number }> }} rep 信誉表
 * @returns {number} 排序分
 */
function repScore(nodeId, rep) {
	const score = Number(rep.byNodeHash?.[nodeId]?.score ?? 0)
	return clampReputationScore(Number.isFinite(score) ? score : 0)
}

/** explore 选取时单 source 上限 */
export const EXPLORE_MAX_PER_SOURCE = 3

/**
 * trusted 锚点优先保留，再按信誉填充剩余槽位。
 * @param {string[]} existingTrusted 既有 trusted
 * @param {string[]} rankedCandidates 信誉排序候选
 * @param {ReturnType<typeof resolveFederationPoolLimits>} limits 槽位
 * @param {string[]} [blockedPeers] 拉黑列表
 * @returns {string[]} 新 trusted 列表
 */
export function mergeTrustedWithAnchors(existingTrusted, rankedCandidates, limits, blockedPeers = []) {
	const blocked = new Set(blockedPeers)
	const candidateSet = new Set(rankedCandidates.filter(id => id && !blocked.has(id)))
	const anchored = existingTrusted.filter(id => id && !blocked.has(id) && candidateSet.has(id))
	const anchoredSet = new Set(anchored)
	const fill = rankedCandidates.filter(id => id && !blocked.has(id) && !anchoredSet.has(id))
	return [...anchored, ...fill].slice(0, limits.trustedSlots)
}

/**
 * 按 source 轮询选取 explore，限制单源占比。
 * @param {string[]} exploreIds 候选 nodeHash
 * @param {Map<string, string> | undefined} exploreSources nodeHash → source
 * @param {number} k 选取数量
 * @param {number} [maxPerSource=EXPLORE_MAX_PER_SOURCE] 每源上限
 * @returns {string[]} 选取结果
 */
export function selectExploreWithSourceQuota(exploreIds, exploreSources, k, maxPerSource = EXPLORE_MAX_PER_SOURCE) {
	if (k <= 0 || !exploreIds.length) return []
	if (!exploreSources?.size)
		return shuffleInPlace([...exploreIds]).slice(0, k)
	/** @type {Map<string, string[]>} */
	const bySource = new Map()
	for (const id of exploreIds) {
		const source = exploreSources.get(id) || 'unknown'
		if (!bySource.has(source)) bySource.set(source, [])
		bySource.get(source).push(id)
	}
	for (const ids of bySource.values()) shuffleInPlace(ids)
	const out = []
	/** @type {Map<string, number>} */
	const picked = new Map()
	while (out.length < k) {
		let progressed = false
		for (const [source, ids] of bySource) {
			if (out.length >= k) break
			const index = picked.get(source) ?? 0
			if (index >= maxPerSource || index >= ids.length) continue
			out.push(ids[index])
			picked.set(source, index + 1)
			progressed = true
		}
		if (!progressed) break
	}
	return out
}

/**
 * 稀疏连接池纯选取：给定在线列表、已持久化 peers 状态与信誉表，
 * 输出按 Top-K trusted + M random explore + 剩余按信誉补至 maxPeers 的 peerId 列表。
 *
 * @param {{
 *   roster: Array<{ peerId: string, remoteNodeHash?: string }>,
 *   peers: { trustedPeers: string[], explorePeers: string[], blockedPeers: string[] },
 *   rep: { byNodeHash?: Record<string, { score?: number }> },
 *   limits: ReturnType<typeof resolveFederationPoolLimits>,
 *   selfNodeHash: string,
 *   inRoomNodeHashes?: Set<string> | string[] 群内在线 node_id；有则优先，仅全不可达时用 explore 中非房内节点
 *   hintSources?: Map<string, string> explore 节点来源（用于配额）
 * }} options 选取参数（roster、peers、rep、limits、selfNodeHash）
 * @returns {string[]} 目标 peerId 列表（去重，长度 ≤ maxPeers）
 */
export function selectPeerIdsFromPool({ roster, peers, rep, limits, selfNodeHash, inRoomNodeHashes, hintSources }) {
	const blocked = new Set(peers.blockedPeers)
	const roomSet = inRoomNodeHashes instanceof Set
		? inRoomNodeHashes
		: new Set(inRoomNodeHashes || [])
	const onlineAll = roster.filter(
		rosterEntry => rosterEntry.peerId
			&& rosterEntry.remoteNodeHash
			&& rosterEntry.remoteNodeHash !== selfNodeHash
			&& !blocked.has(rosterEntry.remoteNodeHash),
	)
	const onlineInRoom = roomSet.size
		? onlineAll.filter(rosterEntry => roomSet.has(rosterEntry.remoteNodeHash))
		: onlineAll
	const online = onlineInRoom.length ? onlineInRoom : onlineAll
	if (!online.length) return []

	const peerIdByNodeHash = new Map(online.map(rosterEntry => [rosterEntry.remoteNodeHash, rosterEntry.peerId]))
	const trustedSet = new Set(peers.trustedPeers.filter(nodeHash => peerIdByNodeHash.has(nodeHash)))
	const exploreSet = new Set(peers.explorePeers.filter(nodeHash => peerIdByNodeHash.has(nodeHash) && !trustedSet.has(nodeHash)))

	const outPeerIds = new Set()
	/**
	 * @param {string} nodeHash 远端节点 hash
	 */
	const pushNode = nodeHash => {
		const peerId = peerIdByNodeHash.get(nodeHash)
		if (peerId) outPeerIds.add(peerId)
	}

	const anchoredTrusted = peers.trustedPeers.filter(nodeHash => trustedSet.has(nodeHash))
	for (const nodeId of mergeTrustedWithAnchors(
		anchoredTrusted,
		[...trustedSet].sort((a, b) => repScore(b, rep) - repScore(a, rep)),
		limits,
	)) {
		if (outPeerIds.size >= limits.maxPeers) break
		pushNode(nodeId)
	}

	const exploreArray = [...exploreSet]
	for (const nodeId of selectExploreWithSourceQuota(exploreArray, hintSources, limits.exploreSlots)) {
		if (outPeerIds.size >= limits.maxPeers) break
		pushNode(nodeId)
	}

	const remainingNodeHashes = [...peerIdByNodeHash.keys()]
		.filter(nodeHash => !trustedSet.has(nodeHash) && !exploreSet.has(nodeHash))
		.sort((a, b) => repScore(b, rep) - repScore(a, rep))
	for (const nodeHash of remainingNodeHashes) {
		if (outPeerIds.size >= limits.maxPeers) break
		pushNode(nodeHash)
	}

	return [...outPeerIds].slice(0, limits.maxPeers)
}

/**
 * 从群成员集合选出应主动建链的 nodeHash（top-K 信任 + M 随机 explore + 强制锚点必连）。
 * 与 selectPeerIdsFromPool 不同：候选是"已知成员 nodeHash"（未必在线），输出用于 ensureLinkToNode 的 nodeHash。
 * 这让大群不再全网状 autoconnect，而是每节点只连少数信任节点 + 随机若干条以保图连通。
 *
 * @param {{
 *   members: Iterable<string>,
 *   selfNodeHash: string,
 *   rep: { byNodeHash?: Record<string, { score?: number, quarantinedUntil?: number }> },
 *   peers: { trustedPeers: string[], explorePeers: string[], blockedPeers: string[], hintSources?: Map<string, string> },
 *   limits: ReturnType<typeof resolveFederationPoolLimits>,
 *   anchors?: Iterable<string>,
 * }} options 选取参数（members、selfNodeHash、rep、peers、limits、anchors）
 * @returns {string[]} 应建链的 nodeHash 列表（去重）
 */
export function selectLinkTargetsFromMembers({ members, selfNodeHash, rep, peers, limits, anchors = [] }) {
	const blocked = new Set(peers?.blockedPeers || [])
	const now = Date.now()
	const candidates = [...new Set(members)]
		.filter(id => id && id !== selfNodeHash && !blocked.has(id) && !isQuarantinedPure(rep, id, now))
	const ranked = candidates.slice().sort((a, b) => repScore(b, rep) - repScore(a, rep))
	const candidateSet = new Set(candidates)
	// 锚点（如 introducer/creator/seed）必连、且不占 trustedSlots——保证引导期连通。
	const forced = [...new Set(anchors)].filter(id => candidateSet.has(id))
	const chosen = new Set(forced)
	// trusted 槽只从非锚点候选填：既有 trusted 优先保留，再按信誉补至 trustedSlots。
	const nonForced = ranked.filter(id => !chosen.has(id))
	for (const id of mergeTrustedWithAnchors(peers?.trustedPeers || [], nonForced, limits))
		chosen.add(id)
	const remaining = ranked.filter(id => !chosen.has(id))
	for (const id of selectExploreWithSourceQuota(remaining, peers?.hintSources, limits.exploreSlots))
		chosen.add(id)
	return [...chosen]
}

/**
 * 将候选 id 并入 explore，并按信誉重填 trusted。
 * @param {{
 *   peers: { trustedPeers: string[], explorePeers: string[], blockedPeers: string[] },
 *   rep: { byNodeHash?: Record<string, { score?: number }> },
 *   addIds: Iterable<string>,
 *   limits: ReturnType<typeof resolveFederationPoolLimits>,
 * }} options 池状态与增量
 * @returns {{ trustedPeers: string[], explorePeers: string[] }} 重算后的 trusted/explore
 */
function rebuildExploreAndTrusted(options) {
	const { peers, rep, addIds, limits } = options
	const blocked = new Set(peers.blockedPeers)
	const explore = new Set(peers.explorePeers)
	for (const id of addIds)
		if (id && !blocked.has(id)) explore.add(id)
	const newExplorePeers = [...explore].filter(id => !blocked.has(id)).slice(-500)
	const ranked = [...new Set([...peers.trustedPeers, ...newExplorePeers])]
		.filter(id => !blocked.has(id))
		.sort((a, b) => repScore(b, rep) - repScore(a, rep))
	return {
		trustedPeers: mergeTrustedWithAnchors(peers.trustedPeers, ranked, limits, peers.blockedPeers),
		explorePeers: newExplorePeers,
	}
}

/**
 * PEX 线索并入 explore 并重填 trusted（纯计算）。
 * @param {{
 *   peers: { trustedPeers: string[], explorePeers: string[], blockedPeers: string[] },
 *   rep: { byNodeHash?: Record<string, { score?: number }> },
 *   hints: string[],
 *   limits: ReturnType<typeof resolveFederationPoolLimits>,
 * }} options 池状态与 PEX hints
 * @returns {{ trustedPeers: string[], explorePeers: string[] }} 重算后的 trusted/explore
 */
export function applyPexHints(options) {
	const { peers, rep, hints, limits } = options
	return rebuildExploreAndTrusted({
		peers, rep, limits,
		addIds: hints || [],
	})
}

/**
 * roster 观测并入 explore 并重填 trusted（纯计算）。
 * @param {{
 *   peers: { trustedPeers: string[], explorePeers: string[], blockedPeers: string[] },
 *   rep: { byNodeHash?: Record<string, { score?: number }> },
 *   roster: { remoteNodeHash?: string }[],
 *   limits: ReturnType<typeof resolveFederationPoolLimits>,
 * }} options 池状态与 roster
 * @returns {{ trustedPeers: string[], explorePeers: string[] }} 重算后的 trusted/explore
 */
export function applyRosterToPeerPool(options) {
	const { peers, rep, roster, limits } = options
	return rebuildExploreAndTrusted({
		peers, rep, limits,
		addIds: roster.map(entry => entry.remoteNodeHash).filter(Boolean),
	})
}

/**
 * 稀疏连接池：优先 trusted，再 explore，再其余在线节点。
 * @param {string} groupId 群
 * @param {{ peerId: string, remoteNodeHash?: string }[]} roster 在线表
 * @param {object} groupSettings 物化群设置
 * @param {string} selfNodeHash 本机 node_id
 * @returns {string[]} 目标 peerId（去重）
 */
export function pickFederationTargetPeerIds(groupId, roster, groupSettings, selfNodeHash) {
	const limits = resolveFederationPoolLimits(groupSettings)
	const peers = loadPeerPoolView(groupId)
	const rep = loadReputation()
	return selectPeerIdsFromPool({
		roster,
		peers,
		rep,
		limits,
		selfNodeHash,
		inRoomNodeHashes: roster.map(entry => entry.remoteNodeHash).filter(Boolean),
		hintSources: peers.hintSources,
	})
}

/**
 * 合并 PEX 提示并提升长期高信誉节点为 trusted。
 * @param {string} groupId 群
 * @param {string[]} hints 节点 id 列表
 * @param {object} groupSettings 群设置
 * @returns {void}
 */
export function mergePexNodeHints(groupId, hints, groupSettings) {
	const limits = resolveFederationPoolLimits(groupSettings)
	const peers = loadPeerPoolView(groupId)
	const rep = loadReputation()
	const { trustedPeers, explorePeers } = applyPexHints({ peers, rep, hints, limits })
	mergeNetworkPeerPools({ trustedPeers, explorePeers })
}

/**
 * roster 观测：将在线节点并入 explore，并按信誉填充 trusted 槽位。
 * @param {string} groupId 群
 * @param {{ remoteNodeHash?: string }[]} roster 在线表
 * @param {object} groupSettings 群设置
 * @returns {void}
 */
export function reconcilePeerPoolFromRoster(groupId, roster, groupSettings) {
	if (!roster.length) return
	const limits = resolveFederationPoolLimits(groupSettings)
	const peers = loadPeerPoolView(groupId)
	const rep = loadReputation()
	const { trustedPeers, explorePeers } = applyRosterToPeerPool({ peers, rep, roster, limits })
	mergeNetworkPeerPools({ trustedPeers, explorePeers })
}

/**
 * Mesh 保活 N/K 槽位（routing profile 可缩 N 与 K_max）。
 * @param {'default' | 'low'} [routingProfile='default'] 路由 profile
 * @param {object} [tunables={}] transport tunables
 * @returns {{ N: number, K_max: number }} mesh 槽位上限 N 与熟人槽 K_max
 */
export function resolveMeshPoolLimits(routingProfile = 'default', tunables = {}) {
	const low = routingProfile === 'low'
	const N = Math.max(1, Math.min(32, Number(low ? tunables.meshNLow : tunables.meshN) || (low ? 4 : 8)))
	const K_max = Math.max(0, Math.min(N, Number(low ? tunables.meshKMaxLow : tunables.meshKMax) || (low ? 2 : 5)))
	return { N, K_max }
}

/**
 * 选取 mesh 拨号目标：补齐 K 熟人（可超出当前空位，由调用方先踢探索），再按 N−K 探索配额填空。
 * @param {{
 *   selfNodeHash: string,
 *   trustedPeers: string[],
 *   exploreCandidates: string[],
 *   hintSources?: Map<string, string>,
 *   limits: ReturnType<typeof resolveMeshPoolLimits>,
 *   connectedHashes: Set<string>,
 *   rep: { byNodeHash?: Record<string, { score?: number, quarantinedUntil?: number }> },
 *   blockedPeers?: string[],
 *   now?: number,
 * }} options 选取参数
 * @returns {string[]} 应拨号的 nodeHash（熟人可导致需先驱逐探索）
 */
export function selectMeshLinkTargets(options) {
	const {
		selfNodeHash,
		trustedPeers = [],
		exploreCandidates = [],
		hintSources,
		limits,
		connectedHashes,
		rep,
		blockedPeers = [],
		now = Date.now(),
	} = options
	const blocked = new Set(blockedPeers)
	const connected = connectedHashes

	const eligibleTrusted = [...new Set(trustedPeers)]
		.filter(id => id && id !== selfNodeHash && !blocked.has(id))
		.filter(id => !isQuarantinedPure(rep, id, now))
	const trustedSet = new Set(eligibleTrusted)
	/** 目标组成：K 熟人槽 + (N−K) 探索槽 */
	const K = Math.min(limits.K_max, eligibleTrusted.length)
	let connectedTrusted = 0
	let connectedExplore = 0
	for (const id of connected)
		if (trustedSet.has(id)) connectedTrusted++
		else connectedExplore++
	const trustedSlotsLeft = Math.max(0, K - connectedTrusted)
	const trustedRanked = eligibleTrusted
		.filter(id => !connected.has(id))
		.sort((a, b) => repScore(b, rep) - repScore(a, rep))
	// 熟人缺口优先补齐，即使当前已满 N（调用方应先踢探索腾位）
	const trustedPick = trustedRanked.slice(0, trustedSlotsLeft)

	const exploreQuota = Math.max(0, limits.N - K)
	const exploreSlotsLeft = Math.max(0, exploreQuota - connectedExplore)
	const freeAfterTrustedDial = Math.max(0, limits.N - connected.size - trustedPick.length)
	const exploreNeed = Math.min(exploreSlotsLeft, freeAfterTrustedDial)
	const explorePool = [...new Set(exploreCandidates)]
		.filter(id => id && id !== selfNodeHash && !blocked.has(id) && !connected.has(id) && !trustedSet.has(id))
		.filter(id => !isQuarantinedPure(rep, id, now))
	const explorePick = selectExploreWithSourceQuota(explorePool, hintSources, exploreNeed)
	return [...trustedPick, ...explorePick]
}

/**
 * mesh trim：探索链优先驱逐，同档取 scope 权重低、nodeHash 小。
 * @param {string[]} linkHashes 当前链路 nodeHash
 * @param {Set<string>} exploreLinkHashes 探索链集合
 * @param {string[]} trustedPeers 熟人池
 * @param {(nodeHash: string) => number} scopeWeightFn scope 权重
 * @returns {string | null} 应驱逐的 nodeHash
 */
export function pickMeshEvictionVictim(linkHashes, exploreLinkHashes, trustedPeers, scopeWeightFn) {
	const trustedSet = new Set(trustedPeers)
	let victimHash = null
	let victimScore = Infinity
	for (const nodeHash of linkHashes) {
		const isExplore = exploreLinkHashes.has(nodeHash) && !trustedSet.has(nodeHash)
		const weight = scopeWeightFn(nodeHash)
		const score = (isExplore ? 0 : 1000) + weight
		if (
			victimHash == null
			|| score < victimScore
			|| (score === victimScore && compareHex64Asc(nodeHash, victimHash) < 0)
		) {
			victimHash = nodeHash
			victimScore = score
		}
	}
	return victimHash
}
