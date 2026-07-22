import { randomUUID } from 'node:crypto'

import { isHex64, normalizeHex64 } from '../core/hexIds.mjs'
import { sendToNodeLink } from '../transport/link_registry.mjs'
import { attachNodeScopeFeature, ensureNodeScope, getNodeScopeWire } from '../transport/node_scope.mjs'

import {
	loadReputation,
	mutateReputation,
} from './reputation_store.mjs'
import { readNodeJsonSync, writeNodeJsonSync } from './storage.mjs'

const SYNC_DATA_NAME = 'reputation_sync'
const MAX_LOCKED_SCORE = 1

/**
 * @typedef {{
 *   trustSyncDonors: string[]
 *   reputationExportAllowlist: string[]
 *   lockedMaxNodeHashes: string[]
 *   lockedMaxPrevByNodeHash: Record<string, number>
 * }} ReputationSyncConfig
 */

/** @type {ReputationSyncConfig | null} */
let syncConfig = null

/** @type {Map<string, { resolve: (v: object) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout>, donor: string }>} */
const pendingPulls = new Map()

/** @type {Set<() => void>} */
const syncWireDisposers = new Set()

let pullTimeoutMs = 8000

/**
 * @param {number} ms 超时毫秒；测试用
 * @returns {void}
 */
export function setReputationPullTimeoutMsForTests(ms) {
	pullTimeoutMs = Math.max(1, Number(ms) || 8000)
}

/**
 * @returns {ReputationSyncConfig} 内存中的 sync 配置（首次从盘加载）
 */
function loadSyncConfig() {
	if (syncConfig) return syncConfig
	const raw = readNodeJsonSync(SYNC_DATA_NAME) || {}
	/** @type {Record<string, number>} */
	const lockedMaxPrevByNodeHash = {}
	const prevRaw = raw.lockedMaxPrevByNodeHash && typeof raw.lockedMaxPrevByNodeHash === 'object'
		? raw.lockedMaxPrevByNodeHash
		: {}
	for (const [nodeHash, score] of Object.entries(prevRaw)) {
		const id = normalizeHex64(nodeHash)
		const n = Number(score)
		if (id && isHex64(id) && Number.isFinite(n)) lockedMaxPrevByNodeHash[id] = n
	}
	syncConfig = {
		trustSyncDonors: normalizeHashList(raw.trustSyncDonors),
		reputationExportAllowlist: normalizeHashList(raw.reputationExportAllowlist),
		lockedMaxNodeHashes: normalizeHashList(raw.lockedMaxNodeHashes),
		lockedMaxPrevByNodeHash,
	}
	return syncConfig
}

/**
 * @param {unknown} list - 原始 hash 列表
 * @returns {string[]} 规范化去重后的 64-hex 列表
 */
function normalizeHashList(list) {
	return [...new Set((Array.isArray(list) ? list : [])
		.map(id => normalizeHex64(id))
		.filter(id => isHex64(id)))]
}

/**
 * @returns {void}
 */
function persistSyncConfig() {
	writeNodeJsonSync(SYNC_DATA_NAME, loadSyncConfig())
}

/**
 * @returns {object} 当前 reputation 表（byNodeHash）
 */
export function getReputationTable() {
	return loadReputation()
}

/**
 * @param {object} table - 含 byNodeHash 的信誉表或裸 byNodeHash 对象
 * @returns {void}
 */
export async function setReputationTable(table) {
	const incoming = table?.byNodeHash && typeof table.byNodeHash === 'object' ? table.byNodeHash : table
	if (!incoming || typeof incoming !== 'object') throw new Error('p2p: setReputationTable requires byNodeHash object')
	await mutateReputation(data => {
		data.byNodeHash = data.byNodeHash || {}
		for (const [nodeHash, row] of Object.entries(incoming)) {
			const id = normalizeHex64(nodeHash)
			if (!id || !isHex64(id)) continue
			const score = Number(row?.score ?? row)
			if (!Number.isFinite(score)) continue
			data.byNodeHash[id] = { ...data.byNodeHash[id] || {}, score }
		}
		applyLocksToReputation(data)
	})
}

/**
 * @param {object} data - reputation 存储对象
 * @returns {void}
 */
function applyLocksToReputation(data) {
	for (const nodeHash of loadSyncConfig().lockedMaxNodeHashes)
		if (!data.byNodeHash[nodeHash]) data.byNodeHash[nodeHash] = { score: MAX_LOCKED_SCORE }
		else data.byNodeHash[nodeHash].score = MAX_LOCKED_SCORE
}

/**
 * 将节点分数钳到上限；首次 lock 时记下原分，unlock 时还原。
 * @param {string[]} nodeHashes - 要 lock 的节点 hash 列表
 * @returns {Promise<void>}
 */
export function lockReputationMax(nodeHashes) {
	const config = loadSyncConfig()
	const hashes = normalizeHashList(nodeHashes)
	return mutateReputation(data => {
		data.byNodeHash = data.byNodeHash || {}
		for (const hash of hashes) {
			if (config.lockedMaxNodeHashes.includes(hash)) continue
			const prev = Number(data.byNodeHash[hash]?.score)
			config.lockedMaxPrevByNodeHash[hash] = Number.isFinite(prev) ? prev : 0
			config.lockedMaxNodeHashes.push(hash)
		}
		persistSyncConfig()
		applyLocksToReputation(data)
	})
}

/**
 * 解除上限钳；还原 lock 前记下的分数。
 * @param {string[]} nodeHashes - 要 unlock 的节点 hash 列表
 * @returns {Promise<void>}
 */
export function unlockReputationMax(nodeHashes) {
	const config = loadSyncConfig()
	const remove = new Set(normalizeHashList(nodeHashes))
	if (!remove.size) return Promise.resolve()
	config.lockedMaxNodeHashes = config.lockedMaxNodeHashes.filter(id => !remove.has(id))
	/** @type {Record<string, number>} */
	const restore = {}
	for (const hash of remove)
		if (Object.hasOwn(config.lockedMaxPrevByNodeHash, hash)) {
			restore[hash] = config.lockedMaxPrevByNodeHash[hash]
			delete config.lockedMaxPrevByNodeHash[hash]
		}

	persistSyncConfig()
	return mutateReputation(data => {
		data.byNodeHash = data.byNodeHash || {}
		for (const [hash, score] of Object.entries(restore))
			if (!data.byNodeHash[hash]) data.byNodeHash[hash] = { score }
			else data.byNodeHash[hash].score = score
	})
}

/**
 * @returns {string[]} 当前锁定为满分的节点 hash 列表
 */
export function getReputationLocks() {
	return [...loadSyncConfig().lockedMaxNodeHashes]
}

/**
 * @param {string[]} donors - 允许拉取信誉的 donor 节点
 * @returns {void}
 */
export function setTrustSyncDonors(donors) {
	loadSyncConfig().trustSyncDonors = normalizeHashList(donors)
	persistSyncConfig()
}

/**
 * @returns {string[]} 当前 trustSyncDonors 副本
 */
export function getTrustSyncDonors() {
	return [...loadSyncConfig().trustSyncDonors]
}

/**
 * @param {string[]} allowlist - 允许导出本机信誉表的节点
 * @returns {void}
 */
export function setReputationExportAllowlist(allowlist) {
	loadSyncConfig().reputationExportAllowlist = normalizeHashList(allowlist)
	persistSyncConfig()
}

/**
 * @returns {string[]} 当前 reputationExportAllowlist 副本
 */
export function getReputationExportAllowlist() {
	return [...loadSyncConfig().reputationExportAllowlist]
}

/**
 * @returns {object} 仅含 score 的导出表
 */
function exportScoreTable() {
	const rep = loadReputation()
	/** @type {Record<string, { score: number }>} */
	const byNodeHash = {}
	for (const [nodeHash, row] of Object.entries(rep.byNodeHash || {}))
		byNodeHash[nodeHash] = { score: Number(row?.score ?? 0) }
	return { byNodeHash }
}

/**
 * 挂载信誉同步 wire（refcount；处理 rep_sync_req / rep_sync_res）。
 * @returns {() => void} 取消 wire 挂载的 dispose
 */
export function attachReputationSyncWire() {
	ensureNodeScope()
	if (!getNodeScopeWire()) throw new Error('p2p: attachReputationSyncWire requires node scope wire')
	const dispose = attachNodeScopeFeature('rep_sync', wire => {
		const offs = [
			wire.on('rep_sync_req', (payload, peerId) => {
				const requester = normalizeHex64(peerId)
				if (!requester || !getReputationExportAllowlist().includes(requester)) return
				try {
					wire.send('rep_sync_res', {
						requestId: payload?.requestId,
						...exportScoreTable(),
					}, peerId)
				}
				catch { /* disconnected */ }
			}),
			wire.on('rep_sync_res', (payload, peerId) => {
				const requestId = String(payload?.requestId || '')
				const pending = pendingPulls.get(requestId)
				if (!pending) return
				if (normalizeHex64(peerId) !== pending.donor) return
				clearTimeout(pending.timer)
				pendingPulls.delete(requestId)
				pending.resolve(payload)
			}),
		]
		return () => {
			for (const off of offs)
				try { off?.() } catch { /* ignore */ }
		}
	})
	syncWireDisposers.add(dispose)
	return () => {
		if (!syncWireDisposers.delete(dispose)) return
		dispose()
	}
}

/**
 * 卸掉信誉同步 wire（强制清掉全部 ref）。
 * @returns {void}
 */
export function detachReputationSyncWire() {
	for (const dispose of [...syncWireDisposers]) {
		syncWireDisposers.delete(dispose)
		try { dispose() } catch { /* ignore */ }
	}
}

/**
 * 从 donor 拉取信誉表 JSON；不落盘。应用需自行 `setReputationTable`。
 * @param {string} nodeHash - donor 节点 64-hex hash
 * @returns {Promise<object>} donor 返回的信誉表
 */
export async function pullReputationFromNode(nodeHash) {
	const donor = normalizeHex64(nodeHash)
	if (!donor || !isHex64(donor)) throw new Error('p2p: pullReputationFromNode requires valid nodeHash')
	if (!getTrustSyncDonors().includes(donor))
		throw new Error('p2p: node not in trustSyncDonors')
	attachReputationSyncWire()
	const requestId = randomUUID()
	const resultPromise = new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pendingPulls.delete(requestId)
			reject(new Error('p2p: rep_sync timeout'))
		}, pullTimeoutMs)
		pendingPulls.set(requestId, { resolve, reject, timer, donor })
	})
	const ok = await sendToNodeLink(donor, {
		scope: 'node',
		action: 'rep_sync_req',
		payload: { requestId },
	})
	if (!ok) {
		const pending = pendingPulls.get(requestId)
		if (pending) {
			clearTimeout(pending.timer)
			pendingPulls.delete(requestId)
		}
		throw new Error('p2p: rep_sync_req send failed')
	}
	return await resultPromise
}

/**
 * @returns {void}
 */
export function resetReputationSyncForTests() {
	syncConfig = null
	detachReputationSyncWire()
	pendingPulls.clear()
	pullTimeoutMs = 8000
}
