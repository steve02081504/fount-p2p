import { nodeDebug, shortHash } from '../../node/log.mjs'

import {
	BACKOFF_BASE_MS,
	BACKOFF_CAP_MS,
	DEFAULT_RTT_MS,
	LAST_GOOD_RELAYS_MAX,
	MAX_ROUTING_ATTEMPTS,
	MAX_ROUTING_FANOUT,
	ROUND0_TARGET_COUNT,
} from './constants.mjs'
import {
	computeRelayHealth,
	getPeerRoute,
	getPinnedRelays,
	getPoolByUrl,
	getWorkingRelays,
	recordPublishResult,
	setPeerRoute,
} from './relays.mjs'
import { publishViaSharedRelay } from './session.mjs'

/**
 * 路由退避延迟（attempt 从 0 开始）。
 * @param {number} attempt 尝试轮次
 * @returns {number} 退避毫秒
 */
export function backoffDelay(attempt) {
	if (attempt <= 0) return 0
	return Math.min(BACKOFF_BASE_MS * (2 ** (attempt - 1)), BACKOFF_CAP_MS)
}

/**
 * 计算对端声称的中继的「综合分」：本机健康分 + 对端上报 RTT。
 * @param {string} url 对端 listen relay
 * @param {import('./relays.mjs').PeerRoute | null} route 对端路由
 * @returns {number} 综合分（越低越优）
 */
function compositeScore(url, route) {
	const ownPool = getPoolByUrl().get(url)
	const ownScore = ownPool ? computeRelayHealth(ownPool) : DEFAULT_RTT_MS
	const peerPool = route?.peerPool?.find(item => item.url === url)
	const peerRtt = peerPool?.rttMs ?? DEFAULT_RTT_MS
	return ownScore + peerRtt
}

/**
 * 对端声称的监听 relay 集，按综合分升序。
 * @param {string} nodeHash 目标节点
 * @returns {Array<{ url: string, score: number }>} 排序后的对端中继
 */
export function getReachPeerRelays(nodeHash) {
	const route = getPeerRoute(nodeHash)
	if (!route?.listenRelays?.length) return []
	return route.listenRelays
		.map(url => ({ url, score: compositeScore(url, route) }))
		.sort((a, b) => a.score - b.score)
}

/**
 * 按健康分加权随机采样（权重 = 1/score，score 越低越可能被选）。
 * 与 getWorkingRelays 共用 computeRelayHealth 评分语义。
 * @param {import('./relays.mjs').RelayPoolEntry[]} entries 候选
 * @param {number} k 采样数量
 * @returns {string[]} 采样 URL
 */
export function weightedRandomSample(entries, k) {
	const weightOf = entry => Math.max(Number.EPSILON, 1 / computeRelayHealth(entry))
	const weights = entries.map(weightOf)
	let total = weights.reduce((a, b) => a + b, 0)
	/** @type {string[]} */
	const picked = []
	const remaining = [...entries]
	while (picked.length < k && remaining.length) {
		let r = Math.random() * total
		let index = 0
		for (let i = 0; i < remaining.length; i++) {
			const w = weightOf(remaining[i])
			if (r < w) { index = i; break }
			r -= w
		}
		const chosen = remaining.splice(index, 1)[0]
		picked.push(chosen.url)
		total -= weightOf(chosen)
	}
	return picked
}

/**
 * 从历史成功集 + 对端综合分补足，扩展至不超过 limit。
 * @param {string} nodeHash 目标节点
 * @param {string[]} base 基础 URL
 * @param {number} limit 上限
 * @returns {string[]} 去重扩展结果
 */
export function expandFromHistory(nodeHash, base, limit) {
	const route = getPeerRoute(nodeHash)
	const reach = getReachPeerRelays(nodeHash)
	/** @type {Set<string>} */
	const seen = new Set()
	/** @type {string[]} */
	const out = []
	for (const url of base) {
		if (!seen.has(url)) { seen.add(url); out.push(url) }
		if (out.length >= limit) break
	}
	for (const { url } of reach) {
		if (seen.has(url)) continue
		seen.add(url)
		out.push(url)
		if (out.length >= limit) break
	}
	// 用工作集补齐（历史不足时）
	const working = getWorkingRelays()
	for (const entry of working) {
		if (seen.has(entry.url)) continue
		seen.add(entry.url)
		out.push(entry.url)
		if (out.length >= limit) break
	}
	return out.slice(0, limit)
}

/**
 * 计算到指定节点的当前轮路由目标集。
 * Round 0：对端声称前4（无则本机工作集前4，再空则 pinned）。
 * Round ≥1：历史成功 + 对端综合分补足 + 加权采样，附退避；总扇出封顶。
 * @param {string} nodeHash 目标节点
 * @param {number} attempt 当前尝试轮次（0 起）
 * @returns {{ urls: string[], backoffDelay: number }} 目标集与退避
 */
export function handshakeTargets(nodeHash, attempt) {
	const seen = new Set()
	/** @type {string[]} */
	const targets = []

	/**
	 * 添加尚未出现的 relay URL。
	 * @param {string} url relay URL
	 * @returns {void}
	 */
	const push = url => {
		if (!seen.has(url)) { seen.add(url); targets.push(url) }
	}

	/**
	 * Round 0：对端声称前 ROUND0_TARGET_COUNT（无则本机工作集，再空则 pinned）。
	 * @returns {void}
	 */
	const round0 = () => {
		const reach = getReachPeerRelays(nodeHash)
		if (reach.length) {
			for (const { url } of reach.slice(0, ROUND0_TARGET_COUNT)) push(url)
			return
		}
		const working = getWorkingRelays()
		if (working.length) {
			for (const entry of working.slice(0, ROUND0_TARGET_COUNT)) push(entry.url)
			return
		}
		const pinned = getPinnedRelays()
		for (const url of pinned.slice(0, ROUND0_TARGET_COUNT)) push(url)
	}

	if (attempt <= 0) {
		round0()
		return { urls: targets.slice(0, MAX_ROUTING_FANOUT), backoffDelay: 0 }
	}

	// Round ≥1
	const route = getPeerRoute(nodeHash)
	if (route?.lastGoodNostrRelays?.length) {
		const base = route.lastGoodNostrRelays
		for (const url of expandFromHistory(nodeHash, base, LAST_GOOD_RELAYS_MAX)) push(url)
	}
	else {
		const working = getWorkingRelays()
		for (const url of weightedRandomSample(working, LAST_GOOD_RELAYS_MAX)) push(url)
	}
	// 公共核心始终尝试
	const core = []
	{
		const reach = getReachPeerRelays(nodeHash)
		if (reach.length) for (const { url } of reach.slice(0, ROUND0_TARGET_COUNT)) core.push(url)
		else for (const entry of getWorkingRelays().slice(0, ROUND0_TARGET_COUNT)) core.push(entry.url)
	}
	for (const url of core) push(url)

	return { urls: targets.slice(0, MAX_ROUTING_FANOUT), backoffDelay: backoffDelay(attempt) }
}

/**
 * 记录成功 relay 到 peerRoutes[hash].lastGoodNostrRelays（去重，保留最近 16）。
 * @param {string} nodeHash 目标节点
 * @param {string[]} okRelays 成功 relay
 * @returns {void}
 */
function recordPeerRouteLastGood(nodeHash, okRelays) {
	const route = getPeerRoute(nodeHash)
	const merged = [...route?.lastGoodNostrRelays || [], ...okRelays]
	const unique = [...new Set(merged)].slice(0, LAST_GOOD_RELAYS_MAX)
	setPeerRoute(nodeHash, { lastGoodNostrRelays: unique })
}

/**
 * 路由发布事件到目标节点：多 relay 并行，任一 OK 即记录 lastGood 并返回；全败则记录并退避重试。
 * @param {string} toNodeHash 目标节点
 * @param {object} event Nostr 事件
 * @param {AbortSignal} [signal] 取消信号
 * @returns {Promise<boolean>} 是否成功发布
 */
export async function routePublishEvent(toNodeHash, event, signal) {
	for (let attempt = 0; attempt < MAX_ROUTING_ATTEMPTS; attempt++) {
		if (signal?.aborted) return false
		const { urls, backoffDelay: delayMs } = handshakeTargets(toNodeHash, attempt)
		if (!urls.length) return false
		const results = await Promise.allSettled(urls.map(url => publishViaSharedRelay(url, event, signal)))
		const okRelays = urls.filter((_, index) => {
			const result = results[index]
			return result.status === 'fulfilled' && result.value === true
		})
		if (okRelays.length) {
			recordPeerRouteLastGood(toNodeHash, okRelays)
			for (const url of okRelays) recordPublishResult(url, true)
			nodeDebug('p2p:nostr route ok', {
				peer: shortHash(toNodeHash),
				attempt,
				relays: okRelays,
			})
			return true
		}
		for (const url of urls) recordPublishResult(url, false)
		if (attempt >= MAX_ROUTING_ATTEMPTS - 1) return false
		if (signal?.aborted) return false
		await new Promise(resolve => {
			/**
			 * 处理 abort 事件：清理定时器与监听器后立即结算。
			 * @returns {void}
			 */
			const onAbort = () => {
				clearTimeout(timer)
				signal?.removeEventListener('abort', onAbort)
				resolve()
			}
			const timer = setTimeout(() => {
				signal?.removeEventListener('abort', onAbort)
				resolve()
			}, delayMs)
			timer.unref?.()
			signal?.addEventListener('abort', onAbort, { once: true })
		})
	}
	return false
}
