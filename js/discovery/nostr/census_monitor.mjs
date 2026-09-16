/**
 * 浏览器端人口统计监控器（无 Node 依赖；WebSocket + Ed25519 验签）。
 *
 * 供 pages 等纯前端消费：`createPopulationMonitor({ onUpdate, relays, signal })`。
 * 开始监听即自动：
 * 1. 连接全部默认（或传入）relay，订阅 census 事件（kind 30789，t=fount / x=census）；
 * 2. 经 NIP-66（kind 30166）发现更多 relay 并加入监听（断开自动指数退避重连）；
 * 3. 每轮刷新取人口估计最大的 relay 作为显示源，把
 *    `{ estimate, sampleSize, eventsInWindow, relayUrl, relays }` 快照传给 onUpdate。
 */
import { base64ToBytes } from '../../core/bytes_codec.mjs'

import {
	CENSUS_TAG_FOUNT,
	CENSUS_TAG_X,
	DEFAULT_RELAY_URLS,
	NIP66_BOOTSTRAP_RELAYS,
	NOSTR_CENSUS_KIND,
} from './constants.mjs'
import { estimatePopulation } from './census_math.mjs'
import { CENSUS_TTL_MS, verifyCensusBytes } from './census_verify.mjs'

/** NIP-66 relay 注册 kind。 */
const NIP66_KIND = 30166
/** NIP-66 发现周期。 */
const NIP66_REFRESH_MS = 30 * 60_000
/** 单次 NIP-66 REQ 上限。 */
const NIP66_REQ_LIMIT = 300
/** 监控 relay 数上限（防 socket 爆炸）。 */
const MAX_MONITOR_RELAYS = 32
/** relay 帧 content 最大长度（超出直接丢弃，避免先 Base64 解码再被拒）。 */
const MAX_FRAME_BYTES = 16 * 1024
/** 并发验签任务上限；达上限时多余帧直接丢弃。 */
const MAX_INFLIGHT_VERIFICATIONS = 8
/** 单次连接超时。 */
const CONNECT_TIMEOUT_MS = 10_000
/** 断线重连指数退避：初始延迟与上限。 */
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
/** 事件入库后刷新防抖。 */
const REFRESH_DEBOUNCE_MS = 300
/** 无事件时周期刷新默认间隔（也用于 TTL 逐出）。 */
const DEFAULT_REFRESH_MS = 5_000

/**
 * 规范化 Nostr relay URL（浏览器端轻量版）：仅 ws/wss，小写 host，去默认端口与尾部斜杠。
 * @param {unknown} raw 原始 URL
 * @returns {string | null} 规范化字符串，无效返回 null
 */
function normalizeRelayUrl(raw) {
	const value = String(raw || '').trim()
	if (!value) return null
	let url
	try { url = new URL(value) } catch { return null }
	if (url.protocol !== 'wss:' && url.protocol !== 'ws:') return null
	if (!url.hostname) return null
	url.hostname = url.hostname.toLowerCase()
	if (url.port && ((url.protocol === 'wss:' && url.port === '443') || (url.protocol === 'ws:' && url.port === '80')))
		url.port = ''
	const path = url.pathname.replace(/\/+$/, '') || '/'
	url.pathname = path
	return url.toString().replace(/\/$/, '')
}

/**
 * @typedef {{
 *   url: string,
 *   ws: WebSocket | null,
 *   subId: string,
 *   events: Map<string, { p: number, at: number }>,
 *   inflight: number,
 *   reconnectDelayMs: number,
 *   reconnectTimer: ReturnType<typeof setTimeout> | null,
 * }} RelaySession
 */

/**
 * 创建人口统计监控器：立即连接并监听，返回 `{ stop }` 控制句柄。
 * @param {{
 *   onUpdate: (snapshot: { estimate: number, sampleSize: number, eventsInWindow: number, relayUrl: string, relays: number }) => void,
 *   relays?: string[],
 *   signal?: AbortSignal,
 *   refreshMs?: number,
 *   discover?: boolean,
 *   nip66Bootstrap?: string[],
 * }} options 选项
 * @returns {{ stop: () => void }} 停止函数
 */
export function createPopulationMonitor(options = {}) {
	const {
		onUpdate,
		relays,
		signal,
		refreshMs = DEFAULT_REFRESH_MS,
		discover = true,
		nip66Bootstrap = NIP66_BOOTSTRAP_RELAYS,
	} = options
	if (typeof onUpdate !== 'function')
		throw new Error('p2p: population monitor requires onUpdate callback')
	/** @type {string[]} */
	const relayUrls = []
	for (const raw of relays && relays.length ? relays : DEFAULT_RELAY_URLS) {
		const url = normalizeRelayUrl(raw)
		if (url && !relayUrls.includes(url)) relayUrls.push(url)
	}
	if (!relayUrls.length)
		throw new Error('p2p: population monitor requires at least one relay url')

	let stopped = false
	/** @type {Map<string, RelaySession>} */
	const sessions = new Map()
	/** @type {ReturnType<typeof setInterval> | null} */
	let refreshTimer = null
	/** @type {ReturnType<typeof setTimeout> | null} */
	let refreshDebounce = null
	/** @type {ReturnType<typeof setInterval> | null} */
	let discoveryTimer = null

	/**
	 * @param {string} url relay URL
	 * @returns {RelaySession} 新会话
	 */
	function createSession(url) {
		return {
			url,
			ws: null,
			subId: '',
			events: new Map(),
			inflight: 0,
			reconnectDelayMs: RECONNECT_BASE_MS,
			reconnectTimer: null,
		}
	}

	/**
	 * 连接会话（含指数退避重连调度）。
	 * @param {RelaySession} session 会话
	 * @returns {void}
	 */
	function connectSession(session) {
		if (stopped || session.ws) return
		const ws = new WebSocket(session.url)
		session.ws = ws
		const connectTimer = setTimeout(() => { try { ws.close() } catch { /* ignore */ } }, CONNECT_TIMEOUT_MS)
		/**
		 * WebSocket 已连接：订阅 census 事件。
		 * @returns {void}
		 */
		const onOpen = () => {
			if (session.ws !== ws) return
			clearTimeout(connectTimer)
			session.reconnectDelayMs = RECONNECT_BASE_MS
			session.subId = 'census-' + Math.random().toString(36).slice(2)
			ws.send(JSON.stringify(['REQ', session.subId, {
				kinds: [NOSTR_CENSUS_KIND],
				'#t': [CENSUS_TAG_FOUNT],
				'#x': [CENSUS_TAG_X],
			}]))
		}
		/**
		 * @param {MessageEvent} event WebSocket 消息事件
		 * @returns {void}
		 */
		const onMessage = event => {
			if (session.ws !== ws) return
			handleRelayMessage(session, event.data)
		}
		/**
		 * 连接关闭：清会话并调度重连。
		 * @returns {void}
		 */
		const onClose = () => {
			clearTimeout(connectTimer)
			if (session.ws !== ws) return
			session.ws = null
			scheduleReconnect(session)
		}
		ws.addEventListener('open', onOpen)
		ws.addEventListener('message', onMessage)
		ws.addEventListener('close', onClose)
		ws.addEventListener('error', () => { /* close follows error */ })
	}

	/**
	 * 指数退避调度重连（去重保护）。
	 * @param {RelaySession} session 会话
	 * @returns {void}
	 */
	function scheduleReconnect(session) {
		if (stopped || session.reconnectTimer) return
		session.reconnectTimer = setTimeout(() => {
			session.reconnectTimer = null
			connectSession(session)
		}, session.reconnectDelayMs)
		session.reconnectDelayMs = Math.min(session.reconnectDelayMs * 2, RECONNECT_MAX_MS)
	}

	/**
	 * 处理单条 relay 消息：验签 census 帧并入库。
	 * @param {RelaySession} session 会话
	 * @param {unknown} data 消息数据
	 * @returns {void}
	 */
	function handleRelayMessage(session, data) {
		if (session.inflight >= MAX_INFLIGHT_VERIFICATIONS) return
		if (typeof data !== 'string' || data.length > MAX_FRAME_BYTES) return
		let parsed
		try { parsed = JSON.parse(data) } catch { return }
		if (parsed?.[0] !== 'EVENT' || parsed[1] !== session.subId) return
		if (parsed[2]?.kind !== NOSTR_CENSUS_KIND) return
		const content = parsed[2]?.content
		if (typeof content !== 'string' || content.length > MAX_FRAME_BYTES) return
		session.inflight++
		void (async () => {
			try {
				const verified = await verifyCensusBytes(base64ToBytes(content))
				if (!verified) return
				const existing = session.events.get(verified.nodeHash)
				if (existing && verified.ts < existing.at) return
				session.events.set(verified.nodeHash, { p: verified.p, at: verified.ts })
				scheduleRefresh()
			}
			catch { /* ignore malformed */ }
			finally { session.inflight-- }
		})()
	}

	/**
	 * 会话快照（逐出过期事件后 HT 估计）。
	 * @param {RelaySession} session 会话
	 * @returns {{ estimate: number, sampleSize: number, eventsInWindow: number }} 快照
	 */
	function sessionSnapshot(session) {
		const now = Date.now()
		const events = []
		for (const [hash, event] of session.events)
			if (now - event.at > CENSUS_TTL_MS) session.events.delete(hash)
			else events.push(event)
		const { estimate, sampleSize } = estimatePopulation(events)
		return { estimate, sampleSize, eventsInWindow: events.length }
	}

	/**
	 * 取人口估计最大的 relay 作为显示源，回调 onUpdate。
	 * @returns {void}
	 */
	function refresh() {
		let best = null
		for (const session of sessions.values()) {
			const snapshot = sessionSnapshot(session)
			if (!best || snapshot.estimate > best.snapshot.estimate)
				best = { url: session.url, snapshot }
		}
		const chosen = best || { url: relayUrls[0], snapshot: { estimate: 0, sampleSize: 0, eventsInWindow: 0 } }
		onUpdate({
			...chosen.snapshot,
			relayUrl: chosen.url,
			relays: sessions.size,
		})
	}

	/**
	 * 防抖调度刷新。
	 * @returns {void}
	 */
	function scheduleRefresh() {
		if (refreshDebounce || stopped) return
		refreshDebounce = setTimeout(() => {
			refreshDebounce = null
			refresh()
		}, REFRESH_DEBOUNCE_MS)
	}

	/**
	 * 单轮 NIP-66 发现：从引导集 + 现有会话拉 kind 30166 候选，加入监听（有界）。
	 * @returns {Promise<void>}
	 */
	async function runDiscovery() {
		/** @type {string[]} */
		const candidates = []
		/** @type {string[]} */
		const sources = []
		for (const url of [...nip66Bootstrap, ...sessions.keys()])
			if (!sources.includes(url)) sources.push(url)
		await Promise.allSettled(sources.map(url => collectNip66Candidates(url, candidate => {
			if (!candidates.includes(candidate)) candidates.push(candidate)
		})))
		for (const url of candidates) {
			if (stopped || sessions.size >= MAX_MONITOR_RELAYS) break
			if (sessions.has(url)) continue
			const session = createSession(url)
			sessions.set(url, session)
			connectSession(session)
		}
	}

	/**
	 * 从单个中继收集 NIP-66 候选（d tag，wss）。
	 * @param {string} relayUrl 发现源中继
	 * @param {(candidate: string) => void} onCandidate 候选回调
	 * @returns {Promise<void>}
	 */
	function collectNip66Candidates(relayUrl, onCandidate) {
		return new Promise(resolve => {
			let ws
			let settled = false
			/** @type {ReturnType<typeof setTimeout> | null} */
			let quietTimer = null
			/**
			 * @returns {void}
			 */
			const finish = () => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				if (quietTimer) clearTimeout(quietTimer)
				try { ws?.close() } catch { /* ignore */ }
				resolve()
			}
			/** 收到候选后 500ms 无新候选即结束（兼容不响应 EOSE 的中继）。 */
			const armQuiet = () => {
				if (quietTimer) clearTimeout(quietTimer)
				quietTimer = setTimeout(finish, 500)
			}
			const timer = setTimeout(finish, CONNECT_TIMEOUT_MS)
			try { ws = new WebSocket(relayUrl) } catch { finish(); return }
			/**
			 * @param {MessageEvent} event WebSocket 消息事件
			 * @returns {void}
			 */
			const onMessage = event => {
				if (typeof event.data !== 'string') return
				let parsed
				try { parsed = JSON.parse(event.data) } catch { return }
				if (parsed?.[0] === 'EOSE') { finish(); return }
				if (parsed?.[0] !== 'EVENT' || parsed[2]?.kind !== NIP66_KIND) return
				const d = (parsed[2]?.tags || []).find(tag => tag?.[0] === 'd')?.[1]
				const url = normalizeRelayUrl(d)
				if (url) {
					onCandidate(url)
					armQuiet()
				}
			}
			ws.addEventListener('open', () => {
				const subId = 'nip66-' + Math.random().toString(36).slice(2)
				ws.send(JSON.stringify(['REQ', subId, { kinds: [NIP66_KIND, 10166], limit: NIP66_REQ_LIMIT }]))
			})
			ws.addEventListener('message', onMessage)
			ws.addEventListener('close', finish)
			ws.addEventListener('error', () => { /* close follows error */ })
		})
	}

	/**
	 * 启动周期 NIP-66 发现。
	 * @returns {void}
	 */
	function startDiscovery() {
		void runDiscovery().catch(() => { })
		discoveryTimer = setInterval(() => { void runDiscovery().catch(() => { }) }, NIP66_REFRESH_MS)
		discoveryTimer.unref?.()
	}

	/**
	 * 停止监控：关闭全部连接与定时器。
	 * @returns {void}
	 */
	function stop() {
		if (stopped) return
		stopped = true
		signal?.removeEventListener('abort', stop)
		if (refreshTimer) clearInterval(refreshTimer)
		refreshTimer = null
		if (refreshDebounce) clearTimeout(refreshDebounce)
		refreshDebounce = null
		if (discoveryTimer) clearInterval(discoveryTimer)
		discoveryTimer = null
		for (const session of sessions.values()) {
			if (session.reconnectTimer) clearTimeout(session.reconnectTimer)
			session.reconnectTimer = null
			try { session.ws?.close() } catch { /* ignore */ }
			session.ws = null
		}
		sessions.clear()
	}

	for (const url of relayUrls) {
		const session = createSession(url)
		sessions.set(url, session)
		connectSession(session)
	}
	if (discover) startDiscovery()
	refresh()
	if (refreshMs > 0) {
		refreshTimer = setInterval(refresh, refreshMs)
		refreshTimer.unref?.()
	}
	if (signal) {
		if (signal.aborted) { stop(); return { stop } }
		signal.addEventListener('abort', stop, { once: true })
	}
	return { stop }
}
