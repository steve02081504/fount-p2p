import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { assertEquals } from '../helpers/assert.mjs'
import { startFakeRelay } from '../helpers/fake_relay.mjs'
import { resolveLocalChrome } from '../helpers/local_chrome.mjs'
import { buildCensusPacketFromSeed } from '../../discovery/nostr/census.mjs'

const P2P_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))

const MIME_BY_EXTENSION = {
	'.html': 'text/html; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
}

const CENSUS_KIND = 30789

/**
 * @param {number} index 序号
 * @returns {string} 确定性 64 hex seed
 */
function seed(index) {
	return index.toString(16).padStart(64, '0')
}

/**
 * 构建带合法签名的 census nostr 事件（供假中继存储并回放）。
 * @param {string} seedHex 节点 seed
 * @param {number} p 包含概率
 * @returns {Promise<object>} nostr 事件
 */
async function buildCensusEvent(seedHex, p) {
	const packet = await buildCensusPacketFromSeed(seedHex, { p, ts: Date.now() })
	return {
		id: '0'.repeat(64),
		pubkey: '0'.repeat(64),
		created_at: Math.floor(Date.now() / 1000),
		kind: CENSUS_KIND,
		tags: [['t', 'fount'], ['x', 'census']],
		content: Buffer.from(JSON.stringify(packet), 'utf8').toString('base64'),
		sig: '0'.repeat(128),
	}
}

/**
 * 经独立 ws 连接向假中继发布 nostr EVENT（触发存储/扇出）。
 * @param {number} port 中继端口
 * @param {object} event 事件
 * @returns {Promise<void>}
 */
function publishViaWs(port, event) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}`)
		ws.addEventListener('open', () => ws.send(JSON.stringify(['EVENT', event])))
		ws.addEventListener('message', raw => {
			const parsed = JSON.parse(String(raw.data))
			if (parsed[0] === 'OK') {
				try { ws.close() } catch { /* ignore */ }
				resolve()
			}
		})
		ws.addEventListener('error', () => reject(new Error('publish ws error')))
	})
}

/**
 * 注入 importmap：把页面的 esm.sh 包导入映射到本地包根（`..`），
 * 把裸 `@noble/*` 等 npm 导入映射回 esm.sh，从而离线可跑页面。
 * @param {string} html 原始 HTML
 * @returns {string} 注入 importmap 后的 HTML
 */
function injectImportMap(html) {
	const importMap = `<script type="importmap">
{
	"imports": {
		"https://esm.sh/@steve02081504/fount-p2p/": "/",
		"@noble/": "https://esm.sh/@noble/"
	}
}
</script>`
	return html.includes('<script type="importmap">') ? html : html.replace('</head>', importMap + '\n</head>')
}

/**
 * 静态服务包根目录（pages/ 页面 + 包源码 + node_modules，离线可跑）。
 * @returns {Promise<{ port: number, stop: () => Promise<void> }>} 静态服务器句柄
 */
async function startStaticServer() {
	const server = createServer(async (request, response) => {
		const urlPath = new URL(request.url, 'http://127.0.0.1').pathname
		const filePath = path.resolve(P2P_ROOT, urlPath.replace(/^\/+/u, ''))
		if (filePath !== P2P_ROOT && !filePath.startsWith(P2P_ROOT + path.sep)) {
			response.writeHead(403)
			response.end('forbidden')
			return
		}
		try {
			let body = await readFile(filePath)
			const contentType = MIME_BY_EXTENSION[path.extname(filePath)] || 'application/octet-stream'
			if (contentType.startsWith('text/html')) body = injectImportMap(body.toString())
			response.writeHead(200, { 'Content-Type': contentType })
			response.end(body)
		}
		catch {
			response.writeHead(404)
			response.end('not found')
		}
	})
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
	return {
		port: server.address().port,
		/**
		 * @returns {Promise<void>}
		 */
		stop: () => new Promise(resolve => server.close(() => resolve())),
	}
}

test('frontend census page renders live estimate via local chrome + injected relay', async t => {
	const chromePath = await resolveLocalChrome()
	if (!chromePath) return t.skip('本机 PATH 上未找到 chrome/edge — 跳过前端测试')
	const relay = await startFakeRelay(() => true, { broadcast: true, store: true })
	const server = await startStaticServer()
	/** @type {import('playwright-core').Browser | null} */
	let browser = null
	try {
		for (let index = 1; index <= 20; index++)
			await publishViaWs(relay.port, await buildCensusEvent(seed(index), 0.1))
		const { chromium } = await import('playwright-core')
		browser = await chromium.launch({ executablePath: chromePath, headless: true })
		const page = await browser.newPage()
		await page.goto(`http://127.0.0.1:${server.port}/pages/index.html?relay=ws://127.0.0.1:${relay.port}`)
		await page.waitForFunction(() => document.querySelector('#estimate')?.textContent === '200', null, { timeout: 10_000 })
		t.diagnostic(`chrome: ${chromePath}`)

		const estimate = await page.textContent('#estimate')
		const sampleSize = await page.textContent('#sample-size')
		const windowEvents = await page.textContent('#window-events')
		const status = await page.textContent('#status')
		assertEquals(estimate.trim(), '200', `estimate=${estimate}`)
		assertEquals(sampleSize.trim(), '20', `sampleSize=${sampleSize}`)
		assertEquals(windowEvents.trim(), '20', `windowEvents=${windowEvents}`)
		assertEquals(status.includes(`ws://127.0.0.1:${relay.port}`), true, `status=${status}`)

		await page.uncheck('#toggle')
		await page.waitForFunction(() => document.querySelector('#estimate')?.textContent === '0', null, { timeout: 10_000 })
		assertEquals((await page.textContent('#estimate')).trim(), '0')
		assertEquals((await page.textContent('#sample-size')).trim(), '0')
		assertEquals((await page.textContent('#window-events')).trim(), '0')

		await page.check('#toggle')
		await page.waitForFunction(() => document.querySelector('#estimate')?.textContent === '200', null, { timeout: 10_000 })
	}
	finally {
		await browser?.close()
		await server.stop()
		await relay.stop()
	}
})
