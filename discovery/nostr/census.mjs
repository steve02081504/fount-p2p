/**
 * 基于 nostr 的人口统计（census）：由 `features.census` 开关驱动。
 *
 * 事件 kind 30789，tag `t=fount` / `x=census`；content = base64(JSON 签名体)。
 * 签名体（Untrusted ingress，需 canonicalize）：
 *   { nodeHash, nodePubKey, ts, p, sig }，签名消息 `fount-census\0ts\0nodeHash\0p`，
 *   用节点身份（node seed，Ed25519）签名，nodeHash = sha256(nodePubKey)。
 *
 * 每窗口（10min）：
 *   E = 窗口内去重事件数（含自身事件）→ if (self 事件在) E--；p' = p·(T/(E+1))
 *   → rand<p 则发布携带 p 的事件。
 * 读者用 HT 估计：M̂ = Σ(1/p)（含自身事件）− 1/p_self（-1：把自身事件移出自己的数据）
 *   + 1（+1：自己确定性存在）。缺 -1 会把自己虚增成 1/p_self 人（p=0.01 时 100 人），
 *   缺 +1 则漏掉自己——两操作独立，不能抵消。
 */
import { Buffer } from 'node:buffer'

import { isHex64, isSignatureHex128 } from '../../core/hexIds.mjs'
import { keyPairFromSeed, pubKeyHash, sign, verify } from '../../crypto/crypto.mjs'
import { ensureNodeSeed, getNodeHash } from '../../node/identity.mjs'
import { getP2PFeatures, isNodeInitialized } from '../../node/instance.mjs'
import { nodeDebug } from '../../node/log.mjs'

import {
	CENSUS_MIN_P,
	CENSUS_TARGET_EVENTS,
	estimatePopulation,
	nextInclusionProbability,
} from './census_math.mjs'

/** Nostr census 事件 kind（每节点每窗口至多一条，按 nodeHash 去重）。 */
export const NOSTR_CENSUS_KIND = 30789

/** census 订阅/发布标签：`t=fount` + `x=census`（subscribeNostrKind 以 rendezvousKey/tagX 匹配）。 */
const CENSUS_TAG_FOUNT = 'fount'
const CENSUS_TAG_X = 'census'
const CENSUS_TAGS = [['t', CENSUS_TAG_FOUNT], ['x', CENSUS_TAG_X]]

/** 事件/窗口存活时间（与 advert TTL 一致）。 */
const CENSUS_TTL_MS = 10 * 60_000
/** 发布/统计周期。 */
const CENSUS_INTERVAL_MS = 10 * 60_000
/** 冷启动初始包含概率。 */
const CENSUS_INITIAL_P = 0.5

/**
 * @param {number} ts 时间戳（毫秒）
 * @param {string} nodeHash 64 hex 节点 hash
 * @param {number} p 包含概率
 * @returns {Buffer} 待签名消息
 */
function buildCensusMessage(ts, nodeHash, p) {
	return Buffer.from(`fount-census\0${ts}\0${nodeHash}\0${p}`, 'utf8')
}

/**
 * 用指定 seed 身份构建签名 census 包（nodeHash 由 seed 派生）。
 * 供工具与测试构造任意身份的 peer 包。
 * @param {string} seedHex 64 hex seed
 * @param {{ p: number, ts?: number }} options 包含概率与时间戳
 * @returns {Promise<{ nodeHash: string, nodePubKey: string, ts: number, p: number, sig: string }>} 签名包
 */
export async function buildCensusPacketFromSeed(seedHex, { p, ts = Date.now() }) {
	if (!isHex64(seedHex)) throw new Error('p2p: census invalid seed')
	if (!Number.isFinite(p) || p <= 0 || p > 1) throw new Error('p2p: census invalid p')
	const { publicKey, secretKey } = keyPairFromSeed(Buffer.from(seedHex, 'hex'))
	const nodeHash = pubKeyHash(publicKey)
	return {
		nodeHash,
		nodePubKey: Buffer.from(publicKey).toString('hex'),
		ts,
		p,
		sig: Buffer.from(await sign(buildCensusMessage(ts, nodeHash, p), secretKey)).toString('hex'),
	}
}

/**
 * 校验 census 包（Untrusted ingress）：canonicalize + 验签 + 时间窗 + p 范围。
 * @param {unknown} packet 原始 census 包
 * @param {number} [now=Date.now()] 当前时间（毫秒）
 * @param {number} [ttlMs=CENSUS_TTL_MS] 允许的时间窗
 * @returns {Promise<{ nodeHash: string, p: number, ts: number } | null>} 校验通过返回 nodeHash/p/ts，否则 null
 */
export async function verifyCensusPacket(packet, now = Date.now(), ttlMs = CENSUS_TTL_MS) {
	const nodeHash = isHex64(packet?.nodeHash)
	const nodePubKey = isHex64(packet?.nodePubKey)
	const sig = isSignatureHex128(packet?.sig)
	const ts = Number(packet?.ts)
	const p = Number(packet?.p)
	if (!nodeHash || !nodePubKey || !sig || !Number.isFinite(ts)) return null
	if (Math.abs(now - ts) > ttlMs) return null
	if (!Number.isFinite(p) || p < CENSUS_MIN_P || p > 1) return null
	try {
		if (pubKeyHash(Buffer.from(nodePubKey, 'hex')) !== nodeHash) return null
	}
	catch {
		return null
	}
	return await verify(Buffer.from(sig, 'hex'), buildCensusMessage(ts, nodeHash, p), Buffer.from(nodePubKey, 'hex')) ? { nodeHash, p, ts } : null
}

/**
 * 解 base64 content 字节并校验 census 包。
 * @param {Uint8Array} bytes content 解码字节
 * @param {number} [now=Date.now()] 当前时间（毫秒）
 * @param {number} [ttlMs=CENSUS_TTL_MS] 允许的时间窗
 * @returns {Promise<{ nodeHash: string, p: number, ts: number } | null>} 校验通过结果或 null
 */
export async function verifyCensusBytes(bytes, now = Date.now(), ttlMs = CENSUS_TTL_MS) {
	try {
		return await verifyCensusPacket(JSON.parse(Buffer.from(bytes).toString('utf8')), now, ttlMs)
	}
	catch {
		return null
	}
}

/** 窗口事件：nodeHash → { p, at }（模块级，与 visibleByHash 同模式）。 */
const censusEvents = new Map()

/**
 * 写入一个已验签 census 事件（按 nodeHash 去重，保留最新）。
 * @param {string} nodeHash 64 hex 节点 hash
 * @param {number} p 包含概率
 * @param {number} [at=Date.now()] 事件时间戳（毫秒）
 * @returns {void}
 */
function noteCensusEvent(nodeHash, p, at = Date.now()) {
	censusEvents.set(nodeHash, { p, at })
}

/**
 * 清理过期窗口事件。
 * @param {number} [now=Date.now()] 当前时间（毫秒）
 * @param {number} [ttlMs=CENSUS_TTL_MS] TTL
 * @returns {void}
 */
function pruneCensusEvents(now = Date.now(), ttlMs = CENSUS_TTL_MS) {
	for (const [hash, event] of censusEvents)
		if (now - event.at > ttlMs) censusEvents.delete(hash)
}

/**
 * @param {number} [now=Date.now()] 当前时间（毫秒）
 * @param {number} [ttlMs=CENSUS_TTL_MS] TTL
 * @returns {Array<{ p: number, at: number }>} 窗口内有效事件（含 p/at）
 */
function listCensusEvents(now = Date.now(), ttlMs = CENSUS_TTL_MS) {
	pruneCensusEvents(now, ttlMs)
	return [...censusEvents.values()]
}

/**
 * 自身 census 事件是否在窗口内（若在，返回其包含概率 p）。
 * self 事件计入窗口数据（onPayload 不排除），此处供 multiplier（--）与 estimate（-1 权重）移出自身。
 * @param {number} [now=Date.now()] 当前时间（毫秒）
 * @param {number} [ttlMs=CENSUS_TTL_MS] TTL
 * @returns {{ p: number } | null} 自身事件或 null
 */
function selfCensusEvent(now = Date.now(), ttlMs = CENSUS_TTL_MS) {
	const event = censusEvents.get(getNodeHash())
	return event && now - event.at <= ttlMs ? { p: event.p } : null
}

/** @returns {void} 测试用：清空窗口 */
export function resetCensusEvents() {
	censusEvents.clear()
}

/**
 * 当前在线节点数估计（HT：Σ 1/p 对端 + 1 自身）。
 * @param {number} [now=Date.now()] 当前时间（毫秒）
 * @param {number} [ttlMs=CENSUS_TTL_MS] TTL
 * @returns {{ estimate: number, sampleSize: number, eventsInWindow: number }} 估计与采样信息
 */
export function getNodePopulationEstimate(now = Date.now(), ttlMs = CENSUS_TTL_MS) {
	const events = listCensusEvents(now, ttlMs)
	const { estimate, sampleSize } = estimatePopulation(events)
	let total = estimate
	if (isNodeInitialized() && getP2PFeatures().census) {
		const selfEvent = selfCensusEvent(now, ttlMs)
		if (selfEvent) total -= 1 / selfEvent.p
		total++
	}
	return { estimate: total, sampleSize, eventsInWindow: events.length }
}

/**
 * 创建 census worker：每周期读 `features.census`，disabled 则跳过；订阅与发布仅在 enabled 时进行。
 * @param {{
 *   resolveRelayUrls: () => string[],
 *   publishEvent: (relayUrls: string[], event: object, signal?: AbortSignal) => Promise<void>,
 *   signEvent: (kind: number, tags: string[][], content: string) => Promise<object>,
 *   subscribeNostrKind: (relayUrls: string[], options: object) => () => void,
 *   now?: () => number
 * }} deps 依赖（由 nostr provider 注入闭包）
 * @returns {{ start: () => void, stop: () => void }} worker 控制
 */
export function createNostrCensus(deps) {
	const { resolveRelayUrls, publishEvent, signEvent, subscribeNostrKind, now = Date.now } = deps
	/** @type {number} */
	let localP = CENSUS_INITIAL_P
	/** @type {() => void} */
	let stopSubscription = () => { }
	let subscribed = false
	/** @type {ReturnType<typeof setInterval> | null} */
	let timer = null
	const abortController = new AbortController()

	/**
	 * 确保 census 订阅（幂等）。
	 * @returns {void}
	 */
	function ensureSubscription() {
		if (subscribed) return
		subscribed = true
		stopSubscription = subscribeNostrKind(resolveRelayUrls(), {
			kind: NOSTR_CENSUS_KIND,
			rendezvousKey: CENSUS_TAG_FOUNT,
			tagX: CENSUS_TAG_X,
			/**
			 * @param {Uint8Array} bytes content 字节
			 * @returns {Promise<void>}
			 */
			async onPayload(bytes) {
				const verified = await verifyCensusBytes(bytes, now())
				if (verified) noteCensusEvent(verified.nodeHash, verified.p, verified.ts)
			},
		})
	}

	/**
	 * 单周期：读开关 → 订阅 → 更新 p → 掷币发布。
	 * @returns {Promise<void>}
	 */
	const run = async () => {
		if (abortController.signal.aborted) return
		if (!isNodeInitialized() || !getP2PFeatures().census) return
		ensureSubscription()
		let observed = listCensusEvents(now()).length
		if (selfCensusEvent(now())) observed--
		localP = nextInclusionProbability(localP, observed + 1, CENSUS_TARGET_EVENTS)
		if (Math.random() >= localP) return
		try {
			const packet = await buildCensusPacketFromSeed(ensureNodeSeed(), { p: localP, ts: now() })
			const event = await signEvent(NOSTR_CENSUS_KIND, CENSUS_TAGS, Buffer.from(JSON.stringify(packet), 'utf8').toString('base64'))
			await publishEvent(resolveRelayUrls(), event, abortController.signal)
			nodeDebug('p2p:census published', { p: localP })
		}
		catch (error) {
			nodeDebug('p2p:census publish fail', { err: String(error?.message || error) })
		}
	}

	/**
	 * 启动 worker（立即跑一轮 + 每 CENSUS_INTERVAL_MS 一轮）。
	 * @returns {void}
	 */
	function start() {
		void run().catch(() => { })
		timer = setInterval(() => { void run().catch(() => { }) }, CENSUS_INTERVAL_MS)
		timer.unref?.()
	}

	/**
	 * 停止 worker 与订阅。
	 * @returns {void}
	 */
	function stop() {
		abortController.abort()
		if (timer) clearInterval(timer)
		timer = null
		stopSubscription()
		subscribed = false
	}

	return { start, stop }
}
