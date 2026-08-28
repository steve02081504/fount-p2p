/**
 * fount 人口统计前端（独立实现，不依赖包内代码）。
 * - 浏览器原生 WebSocket 订阅 Nostr 中继 kind=30789 / #t=fount / #x=census。
 * - 本地用 @noble 验签（懒加载，仅 live 模式需要）。
 * - 在线节点数估计 = Σ(1/p)（HT）。
 * - `?demo=1`（或无 relay 参数）进入演示模式：喂入 20 条 p=0.1 的样本 → 估计 200。
 */
const CENSUS_KIND = 30789
const CENSUS_TTL_MS = 10 * 60_000
const TARGET_EVENTS = 20

const estimateEl = document.querySelector('#estimate')
const sampleEl = document.querySelector('#sample-size')
const windowEl = document.querySelector('#window-events')
const statusEl = document.querySelector('#status')
const footerEl = document.querySelector('#footer')
const toggleEl = document.querySelector('#toggle')

const params = new URLSearchParams(location.search)
const relayUrl = params.get('relay')
const demoMode = params.get('demo') === '1' || !relayUrl

/** @type {Map<string, { p: number, at: number }>} */
const events = new Map()
let ws = null
let enabled = true

/** @param {number} p @returns {number} */
function clampP(p) {
	if (!Number.isFinite(p)) return 0.001
	return Math.min(1, Math.max(0.001, p))
}

/** @param {number} p @param {number} observed @param {number} [target] @returns {number} */
function nextInclusionProbability(p, observed, target = TARGET_EVENTS) {
	const E = Math.max(0, Math.floor(observed))
	const T = Math.max(1, Math.floor(target))
	const base = clampP(p)
	if (E === 0) return clampP(base * 1.5)
	return clampP(base * (T / E))
}

/**
 * HT 估计。
 * @returns {{ estimate: number, sampleSize: number }}
 */
function estimatePopulation() {
	let total = 0
	let sampleSize = 0
	const now = Date.now()
	for (const { p, at } of events.values()) {
		if (!Number.isFinite(p) || p <= 0 || p > 1) continue
		if (!Number.isFinite(at) || now - at > CENSUS_TTL_MS) continue
		total += 1 / p
		sampleSize++
	}
	return { estimate: total, sampleSize }
}

/** 懒加载验签所需 noble 模块（仅 live 模式）。 */
let noblePromise = null
function loadNoble() {
	if (!noblePromise) noblePromise = Promise.all([
		import('https://esm.sh/@noble/curves@1/ed25519.js'),
		import('https://esm.sh/@noble/hashes@1/sha2.js'),
	])
	return noblePromise
}

/**
 * 校验 census 包：nodeHash=sha256(nodePubKey) 且 Ed25519 签名匹配 `fount-census\0ts\0nodeHash\0p`。
 * @param {object} packet 原始包
 * @returns {Promise<{ nodeHash: string, p: number, ts: number } | null>}
 */
async function verifyCensusPacket(packet) {
	const nodeHash = /^[\da-f]{64}$/u.test(String(packet?.nodeHash ?? '')) ? packet.nodeHash : null
	const nodePubKey = /^[\da-f]{64}$/u.test(String(packet?.nodePubKey ?? '')) ? packet.nodePubKey : null
	const sig = /^[\da-f]{128}$/u.test(String(packet?.sig ?? '')) ? packet.sig : null
	const ts = Number(packet?.ts)
	const p = Number(packet?.p)
	if (!nodeHash || !nodePubKey || !sig || !Number.isFinite(ts)) return null
	if (Math.abs(Date.now() - ts) > CENSUS_TTL_MS) return null
	if (!Number.isFinite(p) || p <= 0 || p > 1) return null
	const [{ ed25519 }, { sha256 }] = await loadNoble()
	const pubBytes = new Uint8Array(nodePubKey.match(/.{2}/gu).map(hex => parseInt(hex, 16)))
	const hashHex = [...sha256(pubBytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
	if (hashHex !== nodeHash) return null
	const message = new TextEncoder().encode(`fount-census\0${ts}\0${nodeHash}\0${p}`)
	const sigBytes = new Uint8Array(sig.match(/.{2}/gu).map(hex => parseInt(hex, 16)))
	const ok = ed25519.verify(sigBytes, message, pubBytes)
	return ok ? { nodeHash, p, ts } : null
}

/** @param {object} packet @returns {void} */
function ingest(packet) {
	const hash = String(packet?.nodeHash ?? '')
	if (!/^[\da-f]{64}$/u.test(hash)) return
	events.set(hash, { p: Number(packet.p), at: Number(packet.ts) })
	render()
}

function render() {
	const { estimate, sampleSize } = estimatePopulation()
	estimateEl.textContent = estimate.toLocaleString('zh-CN', { maximumFractionDigits: 1 })
	sampleEl.textContent = String(sampleSize)
	windowEl.textContent = String(events.size)
}

function seedDemo() {
	events.clear()
	for (let index = 0; index < 20; index++) {
		const fakeHash = (index + 1).toString(16).padStart(2, '0').repeat(32)
		events.set(fakeHash, { p: 0.1, at: Date.now() })
	}
	statusEl.textContent = '演示模式：20 条 p=0.1 样本（HT 估计 = 200）'
	footerEl.textContent = '演示模式样本为虚构数据；添加 ?relay=wss://... 进入 live 模式。'
	render()
}

function connectRelay() {
	if (ws) {
		try { ws.close() } catch { /* ignore */ }
		ws = null
	}
	if (!relayUrl || !enabled) return
	statusEl.textContent = `连接 ${relayUrl} …`
	ws = new WebSocket(relayUrl)
	ws.onopen = () => {
		ws.send(JSON.stringify(['REQ', 'census', { kinds: [CENSUS_KIND], '#t': ['fount'], '#x': ['census'] }]))
		statusEl.textContent = `监听 ${relayUrl}（kind ${CENSUS_KIND}）`
	}
	ws.onmessage = async rawMessage => {
		const parsed = JSON.parse(String(rawMessage.data))
		if (parsed?.[0] !== 'EVENT') return
		const event = parsed[1]
		if (event?.kind !== CENSUS_KIND) return
		let packet = null
		try {
			packet = JSON.parse(atob(event.content))
		}
		catch { return }
		const verified = await verifyCensusPacket(packet)
		if (verified) ingest(verified)
	}
	ws.onclose = () => { statusEl.textContent = '已断开' }
	ws.onerror = () => { statusEl.textContent = '中继连接失败' }
}

toggleEl.addEventListener('change', () => {
	enabled = toggleEl.checked
	if (!enabled) {
		events.clear()
		if (ws) { try { ws.close() } catch { /* ignore */ } ws = null }
		statusEl.textContent = '已关闭'
	}
	else if (demoMode) seedDemo()
	else connectRelay()
	render()
})

if (demoMode) seedDemo()
else connectRelay()
render()