/**
 * fount 人口统计前端（薄壳，逻辑由包内 `census_monitor` 封装）。
 * - `createPopulationMonitor` 自动监听全部默认（或传入）relay、经 NIP-66 发现更多，
 *   并取人口估计最大的 relay 作为显示源，把 `{ estimate, sampleSize, eventsInWindow, relayUrl, relays }`
 *   快照连同 relay 地址传给 onUpdate。
 * - 页面只负责：导入监控器、传显示函数与可选 relay 地址。
 */
import { createPopulationMonitor } from 'https://esm.sh/@steve02081504/fount-p2p/discovery/nostr/census_monitor.mjs'

const statusEl = document.querySelector('#status')
const toggleEl = document.querySelector('#toggle')

const params = new URLSearchParams(location.search)
const relayUrl = params.get('relay')

/** @type {{ stop: () => void } | null} */
let monitor = null

/**
 * @param {{ estimate: number, sampleSize: number, eventsInWindow: number }} snapshot 快照
 * @returns {void}
 */
function render(snapshot) {
	document.querySelector('#estimate').textContent = snapshot.estimate.toLocaleString('zh-CN', { maximumFractionDigits: 1 })
	document.querySelector('#sample-size').textContent = String(snapshot.sampleSize)
	document.querySelector('#window-events').textContent = String(snapshot.eventsInWindow)
}

/** @returns {void} 启动 live 监控（默认/传入 relay 全交给库） */
function startLive() {
	if (monitor) return
	try {
		monitor = createPopulationMonitor({
			relays: relayUrl ? [relayUrl] : undefined,
			onUpdate: snapshot => {
				render(snapshot)
				statusEl.textContent = `监听 ${snapshot.relayUrl}（census，共 ${snapshot.relays} 个 relay）`
			},
		})
	}
	catch (error) {
		statusEl.textContent = `中继配置无效：${String(error?.message || error)}`
	}
}

/** @returns {void} 停止监控 */
function stopLive() {
	monitor?.stop()
	monitor = null
}

toggleEl.addEventListener('change', () => {
	if (!toggleEl.checked) {
		stopLive()
		render({ estimate: 0, sampleSize: 0, eventsInWindow: 0 })
		statusEl.textContent = '已关闭'
		return
	}
	startLive()
})

if (toggleEl.checked) startLive()
