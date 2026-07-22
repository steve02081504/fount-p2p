import { isEntityHash128 } from '../core/entity_id.mjs'
import { isHex64, normalizeHex64 } from '../core/hexIds.mjs'

import { loadDenylist } from './denylist.mjs'
import { getNodeDir, isNodeInitialized } from './instance.mjs'
import { bumpLocalDataRevision } from './local_data_revision.mjs'
import { readNodeJsonSync, writeNodeJsonSync } from './storage.mjs'


/**
 * 联邦术语（Wave 6）：
 * - **block**：Social 对外联邦公开拉黑（personal_block / timeline block 事件）
 * - **hide**：纯本地隐藏（personal_hide，不联邦）
 * - **deny**：节点连接拒绝（denylist.json，scope node/subject/entity）
 * - **ban**：群成员治理（member_ban DAG + bannedMembers 物化态）
 *
 * @typedef {{
 *   trustedPeers: string[]
 *   explorePeers: string[]
 *   blockedPeers: string[]
 *   deniedNodes: string[]
 *   deniedSubjects: string[]
 *   deniedEntities: string[]
 *   lastRosterAt: number
 *   hintSources?: Map<string, string>
 * }} PeerPoolView
 */

const DATA_NAME = 'network'
const MAX_EXPLORE = 500
const MAX_TRUSTED = 64
const MAX_HINTS = 256
const MAX_HINTS_PER_SOURCE = 12
const DEFAULT_EXPLORE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** @type {ReturnType<typeof normalizeNetwork> | null} network.json 内存缓存（唯一写路径 saveNetwork 负责刷新） */
let networkCache = null
/** @type {string | null} 缓存所属 nodeDir（切换节点/未初始化时失效） */
let networkCacheNodeDir = null

/**
 * @typedef {{ nodeHash: string, source: string, kind: string, weight?: number, expiresAt: number, groupId?: string }} NetworkHint
 */

/**
 * @param {unknown} raw 磁盘 JSON
 * @returns {{ trustedPeers: string[], explorePeers: string[], hints: NetworkHint[], lastRosterAt: number }} 规范化网络表
 */
export function normalizeNetwork(raw) {
	const file = raw ?? {}
	/**
	 * @param {string} key 字段名
	 * @returns {string[]} 去重 nodeHash 列表
	 */
	const pickIds = key => [...new Set(
		(file[key] || [])
			.map(id => normalizeHex64(id) || id.trim())
			.filter(id => isHex64(id)),
	)]
	const hints = (file.hints || [])
		.map(hint => ({
			nodeHash: normalizeHex64(hint.nodeHash) || '',
			source: hint.source?.trim() || '',
			kind: hint.kind?.trim() || '',
			weight: Number.isFinite(Number(hint.weight)) ? Number(hint.weight) : 0.1,
			expiresAt: Number(hint.expiresAt) || 0,
			...hint.groupId ? { groupId: hint.groupId.trim() } : {},
		}))
		.filter(hint => isHex64(hint.nodeHash))
	return {
		trustedPeers: pickIds('trustedPeers'),
		explorePeers: pickIds('explorePeers'),
		hints,
		lastRosterAt: Number.isFinite(file.lastRosterAt) ? Number(file.lastRosterAt) : 0,
	}
}

/**
 * 节点级 P2P 网络（内存缓存；热路径 loadPeerPoolView 每首见事件都会调用，避免每次同步读盘）。
 * @returns {{ trustedPeers: string[], explorePeers: string[], hints: NetworkHint[], lastRosterAt: number }} 节点级 P2P 网络
 */
export function loadNetwork() {
	const nodeDir = isNodeInitialized() ? getNodeDir() : ''
	if (networkCache && networkCacheNodeDir === nodeDir) return networkCache
	networkCacheNodeDir = nodeDir
	networkCache = normalizeNetwork(readNodeJsonSync(DATA_NAME))
	return networkCache
}

/**
 * 限制同一 source 的 hint 数量，防止 PEX/单源灌满 explore。
 * @param {NetworkHint[]} hints hint 列表
 * @param {number} [maxPerSource=MAX_HINTS_PER_SOURCE] 每源上限
 * @returns {NetworkHint[]} 裁剪后列表（保留较新条目）
 */
export function capHintsBySource(hints, maxPerSource = MAX_HINTS_PER_SOURCE) {
	/** @type {Map<string, number>} */
	const counts = new Map()
	const out = []
	for (const hint of [...hints].reverse()) {
		const source = String(hint.source || 'unknown')
		const n = counts.get(source) ?? 0
		if (n >= maxPerSource) continue
		counts.set(source, n + 1)
		out.unshift(hint)
	}
	return out
}

/**
 * @param {ReturnType<typeof normalizeNetwork>} data 网络表
 * @returns {void}
 */
export function saveNetwork(data) {
	const clean = normalizeNetwork(data)
	const now = Date.now()
	clean.hints = capHintsBySource(clean.hints.filter(h => !h.expiresAt || h.expiresAt > now)).slice(-MAX_HINTS)
	clean.explorePeers = clean.explorePeers.slice(-MAX_EXPLORE)
	clean.trustedPeers = clean.trustedPeers.slice(-MAX_TRUSTED)
	writeNodeJsonSync(DATA_NAME, clean)
	networkCache = clean
	networkCacheNodeDir = isNodeInitialized() ? getNodeDir() : ''
	bumpLocalDataRevision()
}

/**
 * @param {{ nodeHash: string, source: string, kind: string, weight?: number, expiresAt?: number, ttlMs?: number, groupId?: string }} hint 扩边 hint
 * @returns {void}
 */
export function applyNetworkHint(hint) {
	const nodeHash = normalizeHex64(hint?.nodeHash)
	if (!isHex64(nodeHash)) return
	const net = loadNetwork()
	const now = Date.now()
	const ttlMs = Number.isFinite(hint.ttlMs) ? hint.ttlMs : DEFAULT_EXPLORE_TTL_MS
	const expiresAt = Number.isFinite(hint.expiresAt) ? hint.expiresAt : now + ttlMs
	const source = String(hint.source || 'unknown')
	const priorSources = new Set(net.hints.filter(h => h.nodeHash === nodeHash).map(h => String(h.source || 'unknown')))
	priorSources.add(source)
	const multiSourceBoost = priorSources.size >= 2 ? 1.2 : 1
	const baseWeight = Number.isFinite(hint.weight) ? hint.weight : 0.1
	if (!net.explorePeers.includes(nodeHash))
		net.explorePeers.push(nodeHash)
	net.hints = net.hints.filter(h => h.nodeHash !== nodeHash || h.kind !== hint.kind)
	net.hints.push({
		nodeHash,
		source,
		kind: String(hint.kind || 'hint'),
		weight: baseWeight * multiSourceBoost,
		expiresAt,
		...hint.groupId ? { groupId: String(hint.groupId).trim() } : {},
	})
	saveNetwork(net)
}

/**
 * 疑似分区/eclipse 后：用 trusted 锚点加宽 explore，便于恢复联邦可达。
 * @returns {void}
 */
export function widenExploreFromTrustedAnchors() {
	if (!isNodeInitialized()) return
	const net = loadNetwork()
	const now = Date.now()
	for (const raw of net.trustedPeers.slice(0, 12)) {
		const nodeHash = normalizeHex64(raw)
		if (!isHex64(nodeHash)) continue
		if (!net.explorePeers.includes(nodeHash))
			net.explorePeers.push(nodeHash)
		net.hints.push({
			nodeHash,
			source: 'recovery:trusted',
			kind: 'partition_recovery',
			weight: 0.35,
			expiresAt: now + 6 * 60 * 60 * 1000,
		})
	}
	net.hints = capHintsBySource(net.hints).slice(-MAX_HINTS)
	net.explorePeers = net.explorePeers.slice(-MAX_EXPLORE)
	saveNetwork(net)
}

/**
 * 增量合并 trusted/explore 池（不覆盖已有全局池）。
 * @param {{ trustedPeers?: string[], explorePeers?: string[] }} patch 增量
 * @returns {void}
 */
export function mergeNetworkPeerPools(patch = {}) {
	const net = loadNetwork()
	for (const raw of patch.trustedPeers || []) {
		const id = normalizeHex64(raw)
		if (isHex64(id) && !net.trustedPeers.includes(id)) net.trustedPeers.push(id)
	}
	for (const raw of patch.explorePeers || []) {
		const id = normalizeHex64(raw)
		if (isHex64(id) && !net.explorePeers.includes(id)) net.explorePeers.push(id)
	}
	net.lastRosterAt = Date.now()
	saveNetwork(net)
}

/**
 * 稳定探索对端升入熟人池（从 explore 移除并追加 trusted）。
 * @param {string} nodeHash 对端 nodeHash
 * @returns {void}
 */
export function promoteExplorePeer(nodeHash) {
	const net = loadNetwork()
	const id = normalizeHex64(nodeHash)
	if (!isHex64(id)) return
	net.explorePeers = net.explorePeers.filter(peer => peer !== id)
	if (!net.trustedPeers.includes(id)) net.trustedPeers.push(id)
	net.lastRosterAt = Date.now()
	saveNetwork(net)
}

/**
 * 整表替换 trusted/explore 池（可缩池）。
 * @param {{ trustedPeers?: string[], explorePeers?: string[] }} pools - 要替换的 peer 池
 * @returns {void}
 */
export function replaceNetworkPeerPools(pools = {}) {
	const net = loadNetwork()
	if (Array.isArray(pools.trustedPeers))
		net.trustedPeers = pools.trustedPeers.map(id => normalizeHex64(id)).filter(id => isHex64(id))
	if (Array.isArray(pools.explorePeers))
		net.explorePeers = pools.explorePeers.map(id => normalizeHex64(id)).filter(id => isHex64(id))
	net.lastRosterAt = Date.now()
	saveNetwork(net)
}

/**
 * @param {string} groupId 群 scope
 * @param {'node' | 'subject' | 'entity'} scope denylist 作用域
 * @returns {string[]} 规范化 value 列表
 */
function denyValuesForScope(groupId, scope) {
	const gid = String(groupId || '').trim()
	return [...new Set(
		loadDenylist().blocked
			.filter(entry => entry.scope === scope)
			.filter(entry => scope === 'entity' || !entry.groupId || !gid || entry.groupId === gid)
			.map(entry => entry.value),
	)]
}

/**
 * 节点级 network + 群 scope denylist 视图（供 peer_pool 选取）。
 * deniedNodes 用于连接池过滤；deniedSubjects/deniedEntities 供入站校验。
 * @param {string} [groupId] 群 scope；空则仅全局 deny
 * @returns {PeerPoolView} 连接池视图
 */
export function loadPeerPoolView(groupId = '') {
	const net = loadNetwork()
	const deniedNodes = denyValuesForScope(groupId, 'node')
	const deniedSubjects = denyValuesForScope(groupId, 'subject')
	const deniedEntities = denyValuesForScope(groupId, 'entity')
	/** @type {Map<string, string>} */
	const hintSources = new Map()
	for (const hint of net.hints)
		if (!hintSources.has(hint.nodeHash))
			hintSources.set(hint.nodeHash, hint.source)

	return {
		trustedPeers: net.trustedPeers,
		explorePeers: net.explorePeers,
		blockedPeers: deniedNodes,
		deniedNodes,
		deniedSubjects,
		deniedEntities,
		lastRosterAt: net.lastRosterAt,
		hintSources,
	}
}

/**
 * @param {PeerPoolView} view 连接池视图
 * @param {string} key nodeHash / pubKeyHash / entityHash 键
 * @returns {boolean} 是否命中 denylist（按 scope 匹配）
 */
export function isPeerPoolKeyBlocked(view, key) {
	const normalized = String(key || '').trim().toLowerCase()
	if (!normalized) return false
	if (view.deniedNodes.includes(normalized)) return true
	if (view.deniedSubjects.includes(normalized)) return true
	if (isEntityHash128(normalized) && view.deniedEntities.includes(normalized)) return true
	return false
}
