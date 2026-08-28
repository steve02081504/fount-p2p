/**
 * fount 人口统计前端（独立实现，不依赖包内代码）。
 * - 浏览器原生 WebSocket 订阅 Nostr 中继 kind=30789 / #t=fount / #x=census。
 * - 本地用 @noble 验签（懒加载，仅 live 模式需要）。
 * - 在线节点数估计 = Σ(1/p)（HT）。
 * - `?demo=1`（或无 relay 参数）进入演示模式：喂入 20 条 p=0.1 的样本 → 估计 200。
 */
const CENSUS_KIND = 30789
const CENSUS_TTL_MS = 10 * 60_000
const CENSUS_SUB_ID = 'census'
const CENSUS_MIN_P = 0.001

const statusEl = document.querySelector('#status')
const toggleEl = document.querySelector('#toggle')

const params = new URLSearchParams(location.search)
const relayUrl = params.get('relay')
const demoMode = params.get('demo') === '1' || !relayUrl

/** @type {Map<string, { p: number, at: number }>} */
const events = new Map()
let webSocket = null
let enabled = true

/**
 * HT 估计；遍历时逐出过期事件，避免窗口 Map 持续增长。
 * @returns {{ estimate: number, sampleSize: number }} 估计与采样数
 */
function estimatePopulation() {
	let total = 0
	let sampleSize = 0
	const now = Date.now()
	for (const [hash, { p, at }] of events) {
		if (!Number.isFinite(at) || now - at > CENSUS_TTL_MS) { events.delete(hash); continue }
		total += 1 / p
		sampleSize++
	}
	return { estimate: total, sampleSize }
}

let noblePromise = null
/** @returns {Promise<[object, object]>} noble 模块 */
function loadNoble() {
	return noblePromise ||= Promise.all([
		import('https://esm.sh/@noble/curves@1/ed25519.js'),
		import('https://esm.sh/@noble/hashes@1/sha2.js'),
	])
}

/**
 * 校验 census 包：nodeHash=sha256(nodePubKey) 且 Ed25519 签名匹配 `fount-census\0ts\0nodeHash\0p`。
 * @param {object} packet 原始包
 * @returns {Promise<{ nodeHash: string, p: number, ts: number } | null>} 验签结果
 */
async function verifyCensusPacket(packet) {
	const nodeHash = /^[\da-f]{64}$/u.test(String(packet?.nodeHash ?? '')) ? packet.nodeHash : null
	const nodePubKey = /^[\da-f]{64}$/u.test(String(packet?.nodePubKey ?? '')) ? packet.nodePubKey : null
	const sig = /^[\da-f]{128}$/u.test(String(packet?.sig ?? '')) ? packet.sig : null
	const ts = Number(packet?.ts)
	const p = Number(packet?.p)
	if (!nodeHash || !nodePubKey || !sig || !Number.isFinite(ts)) return null
	if (Math.abs(Date.now() - ts) > CENSUS_TTL_MS) return null
	if (!Number.isFinite(p) || p < CENSUS_MIN_P || p > 1) return null
	const [{ ed25519 }, { sha256 }] = await loadNoble()
	const pubBytes = new Uint8Array(nodePubKey.match(/.{2}/gu).map(hex => parseInt(hex, 16)))
	if ([...sha256(pubBytes)].map(byte => byte.toString(16).padStart(2, '0')).join('') !== nodeHash) return null
	const ok = ed25519.verify(
		new Uint8Array(sig.match(/.{2}/gu).map(hex => parseInt(hex, 16))),
		new TextEncoder().encode(`fount-census\0${ts}\0${nodeHash}\0${p}`),
		pubBytes,
	)
	return ok ? { nodeHash, p, ts } : null
}

/** @param {{ nodeHash: string, p: number, ts: number }} verified 已验签 census 包 @returns {void} */
function ingest(verified) {
	const existing = events.get(verified.nodeHash)
	if (existing && verified.ts < existing.at) return
	events.set(verified.nodeHash, { p: verified.p, at: verified.ts })
	render()
}

/** @returns {void} 渲染人口估计 */
function render() {
	const { estimate, sampleSize } = estimatePopulation()
	document.querySelector('#estimate').textContent = estimate.toLocaleString('zh-CN', { maximumFractionDigits: 1 })
	document.querySelector('#sample-size').textContent = String(sampleSize)
	document.querySelector('#window-events').textContent = String(events.size)
}

/** @returns {void} 注入演示数据 */
function seedDemo() {
	events.clear()
	for (let index = 0; index < 20; index++)
		events.set((index + 1).toString(16).padStart(2, '0').repeat(32), { p: 0.1, at: Date.now() })
	statusEl.textContent = '演示模式：20 条 p=0.1 样本（HT 估计 = 200）'
	document.querySelector('#footer').textContent = '演示模式样本为虚构数据；添加 ?relay=wss://... 进入 live 模式。'
}

/** @returns {void} 连接中继并订阅 */
function connectRelay() {
	if (webSocket) {
		try { webSocket.close() } catch { /* ignore */ }
		webSocket = null
	}
	if (!relayUrl || !enabled) return
	statusEl.textContent = `连接 ${relayUrl} …`
	const connection = new WebSocket(relayUrl)
	webSocket = connection
	/** WebSocket 已连接后发送 REQ 订阅 census 事件。 */
	connection.onopen = () => {
		if (connection !== webSocket || !enabled) return
		connection.send(JSON.stringify(['REQ', CENSUS_SUB_ID, { kinds: [CENSUS_KIND], '#t': ['fount'], '#x': ['census'] }]))
		statusEl.textContent = `监听 ${relayUrl}（kind ${CENSUS_KIND}）`
	}
	/**
	 * @param {MessageEvent} rawMessage 中继消息事件
	 * @returns {Promise<void>}
	 */
	connection.onmessage = async rawMessage => {
		if (connection !== webSocket || !enabled) return
		let parsed
		try { parsed = JSON.parse(String(rawMessage.data)) } catch { return }
		if (parsed?.[0] !== 'EVENT' || parsed[1] !== CENSUS_SUB_ID) return
		if (parsed[2]?.kind !== CENSUS_KIND) return
		try {
			const verified = await verifyCensusPacket(JSON.parse(atob(parsed[2].content)))
			if (connection !== webSocket || !enabled) return
			if (verified) ingest(verified)
		}
		catch { /* ignore malformed */ }
	}
	/** WebSocket 关闭时更新状态为已断开。 */
	connection.onclose = () => {
		if (connection !== webSocket || !enabled) return
		statusEl.textContent = '已断开'
	}
	/** WebSocket 出错时提示中继连接失败。 */
	connection.onerror = () => {
		if (connection !== webSocket || !enabled) return
		statusEl.textContent = '中继连接失败'
	}
}

toggleEl.addEventListener('change', () => {
	enabled = toggleEl.checked
	if (!enabled) {
		events.clear()
		if (webSocket) { try { webSocket.close() } catch { /* ignore */ } webSocket = null }
		statusEl.textContent = '已关闭'
	}
	else if (demoMode) seedDemo()
	else connectRelay()
	render()
})

if (demoMode) seedDemo()
else connectRelay()
render()
