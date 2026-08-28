import WebSocket from 'ws'

import { nodeDebug } from '../../node/log.mjs'
import {
	readNostrRelaysJsonSync,
	writeNostrRelaysJsonSync,
} from '../../node/storage.mjs'

import {
	DEFAULT_RTT_MS,
	FAILURE_WEIGHT,
	LAST_GOOD_RELAYS_MAX,
	LISTEN_RELAYS_COUNT,
	MAX_RTT_MS,
	NIP66_BOOTSTRAP_RELAYS,
	NIP66_REFRESH_MS,
	POOL_CAP,
	PROBE_STALE_MS,
	STALE_PENALTY,
	WORKING_RELAYS_COUNT,
} from './constants.mjs'
import { connectRelay, dedupeRelayUrls } from './session.mjs'

/** 默认公共中继（source='public'，永不淘汰）。 */
export const DEFAULT_RELAY_URLS = [
	'wss://relay.damus.io',
	'wss://nos.lol',
	'wss://relay.primal.net',
]

/** 持久化写盘节流延迟。 */
const FLUSH_DELAY_MS = 2_000
/** probe 单次连接超时。 */
const PROBE_TIMEOUT_MS = 10_000
/** NIP-66 发现 REQ limit。 */
const NIP66_REQ_LIMIT = 500
/** 每轮 NIP-66 候选 probe 上限（有界，避免海量候选拖垮节点）。 */
const MAX_NIP66_PROBES_PER_ROUND = 48
/** NIP-66 候选 probe 并发批大小（有界，避免同轮瞬时打满连接）。 */
const NIP66_PROBE_BATCH_SIZE = 8

/** @typedef {'nip66' | 'public' | 'manual' | 'peer'} RelaySource */

/**
 * @typedef {{
 *   url: string,
 *   rttMs: number | null,
 *   successCount: number,
 *   failureCount: number,
 *   lastSuccess: number,
 *   lastFailure: number,
 *   lastProbe: number,
 *   firstSeen: number,
 *   lastSeen: number,
 *   source: RelaySource,
 *   nips: string[],
 *   clearnet: boolean,
 *   monitorCount: number,
 * }} RelayPoolEntry
 */

/**
 * @typedef {{
 *   listenRelays: string[],
 *   peerPool: Array<{ url: string, rttMs: number | null }>,
 *   lastGoodNostrRelays: string[],
 *   lastSeen: number,
 * }} PeerRoute
 */

/** @type {Map<string, RelayPoolEntry>} */
let poolEntries = new Map()
/** @type {Map<string, PeerRoute>} */
let peerRoutes = new Map()
/** @type {boolean} */
let dirty = false
/** @type {ReturnType<typeof setTimeout> | null} */
let flushTimer = null

/** 测试可注入的存储 IO；默认走 nodeDir/nostr/relays.json。 */
let storageIO = {
	/**
	 * 读取 relay 持久化数据。
	 * @returns {object | null} 已读取的 relay 数据
	 */
	read: () => readNostrRelaysJsonSync(),
	/**
	 * 写入 relay 持久化数据。
	 * @param {object} data relay 数据
	 * @returns {void}
	 */
	write: data => writeNostrRelaysJsonSync(data),
}

/** NIP-66 引导集覆盖（测试注入）。 */
let bootstrapRelaysOverride = []
/** 发现开关（测试可禁用，避免单测触发公网）。 */
let discoveryEnabled = true

/**
 * 规范化 Nostr relay URL（唯一入站入口）。
 * - 仅允许 wss://；`ws://` 仅限回环/私有地址（本地测试/开发）。
 * - hostname 小写，去除默认端口，去除尾部斜杠，保留非空 path。
 * @param {unknown} raw 原始 URL
 * @returns {string | null} 规范化字符串，无效返回 null
 */
export function normalizeNostrRelayUrl(raw) {
	const value = String(raw || '').trim()
	if (!value) return null
	let url
	try { url = new URL(value) } catch { return null }
	if (url.protocol === 'wss:') {
		// ok
	}
	else if (url.protocol === 'ws:') {
		const host = url.hostname.toLowerCase()
		const isLoopback = host === 'localhost' || host === '[::1]' || /^127\./.test(host)
		if (!isLoopback) return null
	}
	else return null

	if (!url.hostname) return null
	url.hostname = url.hostname.toLowerCase()
	if (url.port && ((url.protocol === 'wss:' && url.port === '443') || (url.protocol === 'ws:' && url.port === '80')))
		url.port = ''
	const path = url.pathname.replace(/\/+$/, '') || '/'
	url.pathname = path
	return url.toString().replace(/\/$/, '')
}

/**
 * 计算 relay 健康分（越低越优）。
 * @param {Partial<RelayPoolEntry>} entry 条目
 * @returns {number} 健康分
 */
export function computeRelayHealth(entry) {
	const { rttMs, successCount, failureCount, lastProbe } = entry
	const total = (successCount || 0) + (failureCount || 0)
	const failureRate = total > 0 ? (failureCount || 0) / total : 0
	let rtt = rttMs !== undefined && rttMs !== null ? Number(rttMs) : DEFAULT_RTT_MS
	if (!Number.isFinite(rtt)) rtt = DEFAULT_RTT_MS
	rtt = Math.max(1, Math.min(MAX_RTT_MS, rtt))
	let score = rtt * (1 + failureRate * FAILURE_WEIGHT)
	if (Date.now() - (lastProbe || 0) > PROBE_STALE_MS) score *= STALE_PENALTY
	return score
}

/**
 * @param {RelayPoolEntry} entry 条目
 * @returns {boolean} 是否永不淘汰的条目
 */
function isPinned(entry) {
	return entry.source === 'public' || entry.source === 'manual'
}

/** @type {Record<string, number>} source 优先级（值大者优先保留）。 */
const SOURCE_PRIORITY = { manual: 3, public: 2, nip66: 1, peer: 0 }

/**
 * @param {RelayPoolEntry[]} entries 条目
 * @returns {RelayPoolEntry[]} 按健康分排序的条目
 */
function sortByHealth(entries) {
	return [...entries].sort((a, b) => computeRelayHealth(a) - computeRelayHealth(b))
}

/**
 * @param {Iterable<RelayPoolEntry>} entries 条目
 * @returns {RelayPoolEntry[]} 按 URL 去重后的条目
 */
function dedupeByUrl(entries) {
	const seen = new Set()
	/** @type {RelayPoolEntry[]} */
	const out = []
	for (const entry of entries) {
		if (seen.has(entry.url)) continue
		seen.add(entry.url)
		out.push(entry)
	}
	return out
}

/** 标记内存变更并安排节流写盘。 */
function markDirty() {
	dirty = true
	if (flushTimer) return
	flushTimer = setTimeout(() => {
		flushTimer = null
		if (dirty) flushRelayState()
	}, FLUSH_DELAY_MS)
	flushTimer.unref?.()
}

/** 立即把池与 peerRoutes 序列化写盘。 */
function flushRelayState() {
	if (!dirty) return
	dirty = false
	const now = Date.now()
	try {
		storageIO.write({
			updatedAt: now,
			nostrRelays: sortByHealth([...poolEntries.values()]).map(entry => ({ ...entry })),
			peerRoutes: Object.fromEntries(
				[...peerRoutes.entries()].map(([hash, route]) => [hash, { ...route }]),
			),
		})
	}
	catch { /* ignore persist failure */ }
}

/**
 * 从磁盘加载池与 peerRoutes；文件缺失/畸形返回空并播种公共默认。
 * 返回按健康分升序的数组。
 * @returns {RelayPoolEntry[]} 池条目（健康分升序）
 */
export function loadRelayPool() {
	let data = null
	try { data = storageIO.read() } catch { data = null }
	const parsed = data && typeof data === 'object' ? data : null
	poolEntries = new Map()
	peerRoutes = new Map()
	if (Array.isArray(parsed?.nostrRelays))
		for (const raw of parsed.nostrRelays) {
			const url = normalizeNostrRelayUrl(raw?.url)
			if (!url) continue
			const entry = toRelayEntry(raw, url)
			if (entry) poolEntries.set(url, entry)
		}

	if (parsed?.peerRoutes && typeof parsed.peerRoutes === 'object')
		for (const [hash, raw] of Object.entries(parsed.peerRoutes)) {
			const route = normalizePeerRoute(raw)
			if (route) peerRoutes.set(hash, route)
		}

	seedPublicDefaults()
	return sortByHealth([...poolEntries.values()])
}

/**
 * @param {unknown} raw 原始条目
 * @param {string} url 规范化 URL
 * @returns {RelayPoolEntry | null} 规范化条目或 null
 */
function toRelayEntry(raw, url) {
	const source = SOURCE_PRIORITY[String(raw?.source || '')] !== undefined ? raw.source : 'nip66'
	const rttMs = Number(raw?.rttMs)
	/** @type {number | null} */
	const rtt = Number.isFinite(rttMs) ? Math.round(rttMs) : null
	const now = Date.now()
	return {
		url,
		rttMs: rtt,
		successCount: Math.max(0, Math.floor(Number(raw?.successCount) || 0)),
		failureCount: Math.max(0, Math.floor(Number(raw?.failureCount) || 0)),
		lastSuccess: Number(raw?.lastSuccess) || 0,
		lastFailure: Number(raw?.lastFailure) || 0,
		lastProbe: Number(raw?.lastProbe) || 0,
		firstSeen: Number(raw?.firstSeen) || now,
		lastSeen: Number(raw?.lastSeen) || now,
		source,
		nips: Array.isArray(raw?.nips) ? raw.nips.map(String).filter(Boolean) : [],
		clearnet: !!raw?.clearnet,
		monitorCount: Math.max(0, Math.floor(Number(raw?.monitorCount) || 0)),
	}
}

/**
 * 规范化 peer route 中显式出现的字段（缺失字段不出现在结果中）。
 * @param {unknown} raw 原始 peer route
 * @returns {Partial<PeerRoute> | null} 规范化字段或 null
 */
function normalizePeerRouteFields(raw) {
	if (!raw || typeof raw !== 'object') return null
	/** @type {Partial<PeerRoute>} */
	const out = {}
	if (Array.isArray(raw.listenRelays))
		out.listenRelays = dedupeRelayUrls(raw.listenRelays.map(normalizeNostrRelayUrl).filter(Boolean))
	if (Array.isArray(raw.peerPool))
		out.peerPool = dedupeByUrl(raw.peerPool.map(item => {
			const url = normalizeNostrRelayUrl(item?.url)
			if (!url) return null
			const rtt = Number(item?.rttMs)
			return { url, rttMs: Number.isFinite(rtt) ? Math.round(rtt) : null }
		}).filter(Boolean))
	if (Array.isArray(raw.lastGoodNostrRelays))
		out.lastGoodNostrRelays = dedupeRelayUrls(raw.lastGoodNostrRelays.map(normalizeNostrRelayUrl).filter(Boolean)).slice(0, LAST_GOOD_RELAYS_MAX)
	if (raw.lastSeen !== undefined) out.lastSeen = Number(raw.lastSeen) || Date.now()
	return out
}

/**
 * @param {unknown} raw 原始 peer route
 * @returns {PeerRoute | null} 规范化 route（缺失字段补空默认）或 null
 */
function normalizePeerRoute(raw) {
	const fields = normalizePeerRouteFields(raw)
	if (!fields) return null
	return {
		listenRelays: fields.listenRelays ?? [],
		peerPool: fields.peerPool ?? [],
		lastGoodNostrRelays: fields.lastGoodNostrRelays ?? [],
		lastSeen: fields.lastSeen ?? Date.now(),
	}
}

/** 首次为空时把公共默认以 source='public' 播种（保证冷启动非空）。 */
function seedPublicDefaults() {
	for (const url of DEFAULT_RELAY_URLS) {
		const normalized = normalizeNostrRelayUrl(url)
		if (!normalized || poolEntries.has(normalized)) continue
		const now = Date.now()
		poolEntries.set(normalized, {
			url: normalized,
			rttMs: null,
			successCount: 0,
			failureCount: 0,
			lastSuccess: 0,
			lastFailure: 0,
			lastProbe: 0,
			firstSeen: now,
			lastSeen: now,
			source: 'public',
			nips: [],
			clearnet: true,
			monitorCount: 0,
		})
	}
	markDirty()
}

/**
 * 按 url 去重 upsert；合并统计字段。
 * @param {Partial<RelayPoolEntry> & { url: string }} input 新条目
 * @returns {void}
 */
export function upsertRelay(input) {
	const url = normalizeNostrRelayUrl(input.url)
	if (!url) return
	const existing = poolEntries.get(url)
	const now = Date.now()
	if (!existing) {
		const entry = toRelayEntry({ ...input, url, firstSeen: now }, url)
		poolEntries.set(url, entry)
	}
	else {
		const incoming = toRelayEntry({ ...input, url }, url)
		// 统计累加
		existing.successCount += incoming.successCount
		existing.failureCount += incoming.failureCount
		existing.lastSeen = now
		if (incoming.lastSuccess) existing.lastSuccess = incoming.lastSuccess
		if (incoming.lastFailure) existing.lastFailure = incoming.lastFailure
		if (incoming.lastProbe) existing.lastProbe = incoming.lastProbe
		if (incoming.rttMs != null) existing.rttMs = incoming.rttMs
		if (incoming.nips.length) existing.nips = incoming.nips
		existing.clearnet = existing.clearnet || incoming.clearnet
		existing.monitorCount = Math.max(existing.monitorCount, incoming.monitorCount)
		if (SOURCE_PRIORITY[incoming.source] > SOURCE_PRIORITY[existing.source])
			existing.source = incoming.source
	}
	enforcePoolCap()
	markDirty()
}

/** 池容量超限时按健康分淘汰最差且非 pinned 的项。 */
function enforcePoolCap() {
	if (poolEntries.size <= POOL_CAP) return
	const sorted = sortByHealth([...poolEntries.values()])
	let toRemove = poolEntries.size - POOL_CAP
	for (const entry of sorted) {
		if (toRemove <= 0) break
		if (isPinned(entry)) continue
		poolEntries.delete(entry.url)
		nodeDebug('invalidRelayUrl', { url: entry.url, reason: 'pool-cap-evicted' })
		toRemove--
	}
}

/**
 * @param {string} url relay URL
 * @param {number} rttMs 成功 RTT
 * @returns {void}
 */
export function recordProbeSuccess(url, rttMs) {
	const normalized = normalizeNostrRelayUrl(url)
	if (!normalized) return
	const entry = ensureEntry(normalized)
	const rtt = Number(rttMs)
	if (rttMs != null && Number.isFinite(rtt)) entry.rttMs = Math.max(0, Math.min(MAX_RTT_MS, Math.round(rtt)))
	entry.successCount++
	entry.lastSuccess = Date.now()
	entry.lastProbe = Date.now()
	entry.lastSeen = Date.now()
	markDirty()
}

/**
 * @param {string} url relay URL
 * @returns {void}
 */
export function recordProbeFailure(url) {
	const normalized = normalizeNostrRelayUrl(url)
	if (!normalized) return
	const entry = ensureEntry(normalized)
	entry.failureCount++
	entry.lastFailure = Date.now()
	entry.lastProbe = Date.now()
	entry.lastSeen = Date.now()
	markDirty()
}

/**
 * 记录一次发布结果（与探测共用统计）。
 * @param {string} url relay URL
 * @param {boolean} ok 是否成功
 * @returns {void}
 */
export function recordPublishResult(url, ok) {
	if (ok) recordProbeSuccess(url, null)
	else recordProbeFailure(url)
}

/**
 * 获取（若不存在则创建）条目的变更引用。
 * @param {string} url 规范化 URL
 * @returns {RelayPoolEntry} 条目
 */
function ensureEntry(url) {
	let entry = poolEntries.get(url)
	if (entry) return entry
	const now = Date.now()
	entry = {
		url,
		rttMs: null,
		successCount: 0,
		failureCount: 0,
		lastSuccess: 0,
		lastFailure: 0,
		lastProbe: 0,
		firstSeen: now,
		lastSeen: now,
		source: 'nip66',
		nips: [],
		clearnet: true,
		monitorCount: 0,
	}
	poolEntries.set(url, entry)
	return entry
}

/** 移除 lastSeen 超过 24h 且非 public/manual 的项。 */
export function clearStale() {
	const cutoff = Date.now() - PROBE_STALE_MS
	let changed = false
	for (const [url, entry] of [...poolEntries.entries()]) {
		if (isPinned(entry)) continue
		if (entry.lastSeen < cutoff) {
			poolEntries.delete(url)
			changed = true
		}
	}
	if (changed) markDirty()
}

/**
 * @returns {RelayPoolEntry[]} 工作集（健康分升序，含全部 pinned）
 */
export function getWorkingRelays() {
	const sorted = sortByHealth([...poolEntries.values()])
	const pinned = sorted.filter(isPinned)
	const rest = sorted.filter(entry => !isPinned(entry))
	return dedupeByUrl([...pinned, ...rest.slice(0, Math.max(0, WORKING_RELAYS_COUNT - pinned.length))])
}

/**
 * @returns {RelayPoolEntry[]} 监听/发布子集（含全部 public/manual）
 */
export function getListenRelays() {
	const working = getWorkingRelays()
	const pinned = working.filter(isPinned)
	const rest = working.filter(entry => !isPinned(entry))
	return dedupeByUrl([...pinned, ...rest.slice(0, Math.max(0, LISTEN_RELAYS_COUNT - pinned.length))])
}

/**
 * @returns {Map<string, RelayPoolEntry>} url → entry
 */
export function getPoolByUrl() {
	return new Map(poolEntries)
}

/**
 * @param {number} k 数量
 * @param {string[]} [excludeUrls] 排除的 URL
 * @returns {string[]} 健康分最优前 k 个（排除指定 url）
 */
export function pickTopRelays(k, excludeUrls = []) {
	const excluded = new Set(excludeUrls.map(normalizeNostrRelayUrl).filter(Boolean))
	return sortByHealth([...poolEntries.values()])
		.filter(entry => !excluded.has(entry.url))
		.slice(0, k)
		.map(entry => entry.url)
}

/**
 * @returns {string[]} 所有 source='public'/'manual' 的 URL
 */
export function getPinnedRelays() {
	return [...poolEntries.values()]
		.filter(isPinned)
		.map(entry => entry.url)
}

/**
 * @param {string} nodeHash 节点 hash
 * @returns {PeerRoute | null} route 或 null
 */
export function getPeerRoute(nodeHash) {
	const route = peerRoutes.get(nodeHash)
	return route ? { ...route, peerPool: [...route.peerPool], listenRelays: [...route.listenRelays], lastGoodNostrRelays: [...route.lastGoodNostrRelays] } : null
}

/**
 * 更新 peer route（局部 patch），并刷新 lastSeen。
 * 仅规范化并合并 patch 中显式存在的字段，保留已有 listenRelays / peerPool / lastGoodNostrRelays。
 * @param {string} nodeHash 节点 hash
 * @param {Partial<PeerRoute>} patch 补丁
 * @returns {void}
 */
export function setPeerRoute(nodeHash, patch) {
	if (!nodeHash) return
	const existing = peerRoutes.get(nodeHash)
	const normalized = normalizePeerRouteFields(patch)
	if (!normalized) return
	const route = existing
		? { ...existing, ...normalized }
		: {
			listenRelays: normalized.listenRelays ?? [],
			peerPool: normalized.peerPool ?? [],
			lastGoodNostrRelays: normalized.lastGoodNostrRelays ?? [],
			lastSeen: normalized.lastSeen ?? Date.now(),
		}
	route.lastSeen = Date.now()
	peerRoutes.set(nodeHash, route)
	markDirty()
}

/**
 * probe 一个 relay：建立连接测 open RTT，读取 NIP-11 信息。成功更新统计。
 * @param {string} url relay URL
 * @param {AbortSignal} [signal] 外部取消信号
 * @returns {Promise<{ url: string, rttMs: number, nips: string[] } | null>} 成功信息或 null
 */
export async function probeRelay(url, signal) {
	const normalized = normalizeNostrRelayUrl(url)
	if (!normalized) return null
	const controller = new AbortController()
	const startedAt = Date.now()
	let ws = null
	try {
		// 外部取消信号直接中止 WebSocket 连接，避免 shutdown 时遗留 in-flight 连接拖住进程退出。
		ws = await connectRelay(normalized, PROBE_TIMEOUT_MS, signal || controller.signal)
		const rttMs = Date.now() - startedAt
		const info = await queryRelayInfo(normalized, signal)
		recordProbeSuccess(normalized, rttMs)
		return { url: normalized, rttMs, nips: info.nips }
	}
	catch {
		recordProbeFailure(normalized)
		return null
	}
	finally {
		controller.abort()
		if (ws && ws.readyState !== WebSocket.CLOSED)
			try { ws.terminate() } catch { /* ignore */ }
	}
}

/**
 * 拉取单个 relay 的 NIP-11 relay info（max_message_length 已探入池，supported_nips 读取）。
 * @param {string} relayUrl relay URL
 * @param {AbortSignal} [signal] 外部取消信号
 * @returns {Promise<{ nips: string[] }>} NIP-11 信息
 */
async function queryRelayInfo(relayUrl, signal) {
	const httpUrl = relayUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
	const controller = new AbortController()
	/**
	 * @returns {void}
	 */
	const onAbort = () => controller.abort()
	const timer = setTimeout(() => controller.abort(), 4_000)
	timer.unref?.()
	signal?.addEventListener('abort', onAbort, { once: true })
	try {
		const response = await fetch(httpUrl, { headers: { Accept: 'application/nostr+json' }, signal: controller.signal })
		const info = await response.json()
		return { nips: Array.isArray(info?.supported_nips) ? info.supported_nips.map(String) : [] }
	}
	catch {
		return { nips: [] }
	}
	finally {
		clearTimeout(timer)
		signal?.removeEventListener('abort', onAbort)
	}
}

/**
 * 解析单个 NIP-66 kind 30166 事件。
 * @param {object} event Nostr 事件
 * @returns {{ url: string, clearnet: boolean, rttMs: number | null, pubkey: string } | null} 解析结果或 null
 */
export function parseNip66Event(event) {
	const tags = Array.isArray(event?.tags) ? event.tags : []
	const d = (tags.find(tag => tag?.[0] === 'd') || [])[1]
	const url = normalizeNostrRelayUrl(d)
	if (!url) return null
	const n = String((tags.find(tag => tag?.[0] === 'n') || [])[1] || '').toLowerCase()
	const clearnet = n === 'clearnet' || (n === '' && /^wss:\/\//.test(url))
	if (!clearnet) return null
	const N = String((tags.find(tag => tag?.[0] === 'N') || [])[1] || '').trim()
	// N tag 声明时需含 NIP-01；未声明默认接受。
	if (N !== '' && !N.split(',').some(value => value.trim() === '1')) return null
	const rttTag = tags.find(tag => /^rtt-(open|read|write)$/.test(String(tag?.[0] || '')))
	const rttMs = rttTag ? Number(rttTag[1]) : null
	return {
		url,
		clearnet,
		rttMs: Number.isFinite(rttMs) && rttMs != null ? Math.max(0, Math.min(MAX_RTT_MS, Math.round(rttMs))) : null,
		pubkey: String(event?.pubkey || ''),
	}
}

/**
 * 执行一轮 NIP-66 中继发现（可取消）。
 * 连接引导集 + public/manual 兜底，REQ kind 30166 收集候选；所有候选统一 probe，成功才入池。
 * @param {{ signal?: AbortSignal }} [options] 选项
 * @returns {Promise<number>} 新入库的中继数量
 */
export async function discoverNostrRelays(options = {}) {
	const { signal } = options
	const bootstrap = dedupeRelayUrls([
		...bootstrapRelaysOverride.length ? bootstrapRelaysOverride : NIP66_BOOTSTRAP_RELAYS,
		...getPinnedRelays(),
	])
	if (!bootstrap.length) return 0

	/** @type {Map<string, { url: string, count: number, rttMs: number | null, pubkey: string }>} */
	const candidates = new Map()

	await Promise.allSettled(bootstrap.map(async relayUrl => {
		try {
			await collectNip66Events(relayUrl, signal, candidate => {
				const existing = candidates.get(candidate.url)
				if (existing) {
					existing.count++
					if (candidate.pubkey) existing.pubkey = existing.pubkey || candidate.pubkey
				}
				else candidates.set(candidate.url, { url: candidate.url, count: 1, rttMs: candidate.rttMs, pubkey: candidate.pubkey })
			})
		}
		catch { /* skip bad bootstrap */ }
	}))

	let added = 0
	let probedCount = 0
	const pending = [...candidates.values()]
	while (pending.length && probedCount < MAX_NIP66_PROBES_PER_ROUND && !signal?.aborted) {
		const batch = pending.splice(0, Math.min(NIP66_PROBE_BATCH_SIZE, MAX_NIP66_PROBES_PER_ROUND - probedCount))
		probedCount += batch.length
		const results = await Promise.allSettled(batch.map(candidate => probeRelay(candidate.url, signal)))
		for (let index = 0; index < batch.length; index++) {
			const result = results[index]
			if (result.status !== 'fulfilled' || !result.value) continue
			const probed = result.value
			const candidate = batch[index]
			upsertRelay({
				url: probed.url,
				rttMs: probed.rttMs,
				source: 'nip66',
				monitorCount: candidate.count,
				nips: probed.nips,
				clearnet: true,
				lastProbe: Date.now(),
				lastSuccess: Date.now(),
			})
			added++
		}
	}
	return added
}

/**
 * 从单个 NIP-66 中继拉取 kind 30166 事件并回调解析结果（可取消，超时兜底）。
 * @param {string} relayUrl 中继 URL
 * @param {AbortSignal | undefined} signal 取消信号
 * @param {(candidate: { url: string, rttMs: number | null, pubkey: string }) => void} onCandidate 候选回调
 * @returns {Promise<void>}
 */
async function collectNip66Events(relayUrl, signal, onCandidate) {
	const ws = await connectRelay(relayUrl, PROBE_TIMEOUT_MS, signal)
	try {
		const subId = 'nip66-' + Math.random().toString(36).slice(2)
		const filters = [
			{ kinds: [30166], limit: NIP66_REQ_LIMIT },
			{ kinds: [10166], limit: NIP66_REQ_LIMIT },
		]
		await new Promise((resolve, reject) => {
			let settled = false
			/**
			 * @param {Error | null} [err] 失败原因
			 * @returns {void}
			 */
			const finish = err => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				signal?.removeEventListener('abort', onAbort)
				ws.off('message', onMessage)
				ws.off('close', onClose)
				ws.off('error', onError)
				if (err) reject(err)
				else resolve()
			}
			/**
			 * 处理 Nostr WebSocket 消息。
			 * @param {Buffer | ArrayBuffer | Uint8Array | string} data 消息数据
			 * @returns {void}
			 */
			const onMessage = data => {
				let parsed
				try { parsed = JSON.parse(String(data)) } catch { return }
				if (parsed?.[0] === 'EOSE') { finish(); return }
				if (parsed?.[0] !== 'EVENT') return
				const event = parsed[2]
				const candidate = parseNip66Event(event)
				if (candidate) onCandidate(candidate)
			}
			/**
			 * 处理连接关闭。
			 * @returns {void}
			 */
			const onClose = () => finish(new Error('closed'))
			/**
			 * 处理连接错误。
			 * @returns {void}
			 */
			const onError = () => finish(new Error('error'))
			/**
			 * 处理外部取消信号。
			 * @returns {void}
			 */
			const onAbort = () => finish(new Error('aborted'))
			const timer = setTimeout(() => finish(new Error('nip66 timeout')), PROBE_TIMEOUT_MS)
			timer.unref?.()
			ws.on('message', onMessage)
			ws.once('close', onClose)
			ws.once('error', onError)
			signal?.addEventListener('abort', onAbort, { once: true })
			try { ws.send(JSON.stringify(['REQ', subId, ...filters])) } catch (error) { finish(error) }
		})
	}
	finally {
		if (ws.readyState !== WebSocket.CLOSED)
			try { ws.terminate() } catch { /* ignore */ }
	}
}

/**
 * 启动周期 NIP-66 发现：首次在下个 macrotask 执行（不阻塞 startup），之后每 NIP66_REFRESH_MS。
 * @returns {() => void} 停止函数
 */
export function startNostrRelayDiscovery() {
	if (!discoveryEnabled) return () => { }
	let stopped = false
	const controller = new AbortController()
	/**
	 * @returns {void}
	 */
	const run = () => {
		if (stopped) return
		void discoverNostrRelays({ signal: controller.signal }).catch(() => { })
	}
	const firstTimer = setTimeout(run, 0)
	firstTimer.unref?.()
	const timer = setInterval(run, NIP66_REFRESH_MS)
	timer.unref?.()
	return () => {
		stopped = true
		controller.abort()
		clearTimeout(firstTimer)
		clearInterval(timer)
	}
}

/** 立即刷新待写盘状态（测试用）。 */
export function flushRelayStateNow() {
	if (flushTimer) {
		clearTimeout(flushTimer)
		flushTimer = null
	}
	flushRelayState()
}

/**
 * 测试用：注入存储 IO 并复位池状态。
 * @param {{ read: () => object | null, write: (data: object) => void }} io 存储读写实现
 * @returns {void}
 */
export function setRelayStorageIOForTests(io) {
	storageIO = {
		/**
		 * 读取测试存储。
		 * @returns {object | null} 存储数据
		 */
		read: () => {
			try { return io.read() } catch { return null }
		},
		/**
		 * 写入测试存储。
		 * @param {object} data 存储数据
		 * @returns {void}
		 */
		write: data => io.write(data),
	}
	resetNostrRelaysForTests()
}

/**
 * 测试用：禁用/启用 NIP-66 发现（单测避免触发公网）。
 * @param {boolean} enabled 是否启用发现
 * @returns {void}
 */
export function setNostrRelayDiscoveryEnabledForTests(enabled) {
	discoveryEnabled = !!enabled
}

/**
 * 测试用：覆盖 NIP-66 引导集。
 * @param {string[]} urls relay URL 列表
 * @returns {void}
 */
export function setNip66BootstrapRelaysForTests(urls) {
	bootstrapRelaysOverride = Array.isArray(urls) ? urls.map(normalizeNostrRelayUrl).filter(Boolean) : []
}

/** 测试用：清空池与 peerRoutes、定时器（不重播种）。 */
export function clearRelayPoolForTests() {
	if (flushTimer) {
		clearTimeout(flushTimer)
		flushTimer = null
	}
	poolEntries = new Map()
	peerRoutes = new Map()
	dirty = false
}

/** 测试用：清空池与 peerRoutes、定时器并重新播种默认。 */
export function resetNostrRelaysForTests() {
	if (flushTimer) {
		clearTimeout(flushTimer)
		flushTimer = null
	}
	poolEntries = new Map()
	peerRoutes = new Map()
	dirty = false
	seedPublicDefaults()
}
