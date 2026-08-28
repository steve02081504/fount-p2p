import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { assertEquals } from '../helpers/assert.mjs'
import { resolveLocalChrome } from '../helpers/local_chrome.mjs'

const P2P_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const PAGES_ROOT = path.join(P2P_ROOT, 'pages')

const MIME_BY_EXTENSION = {
	'.html': 'text/html; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
}

/**
 * 静态服务 pages/ 目录（仅限 pages/ 下文件，离线可跑）。
 * @returns {Promise<{ port: number, stop: () => Promise<void> }>}
 */
async function startStaticServer() {
	const server = createServer(async (request, response) => {
		const urlPath = new URL(request.url, 'http://127.0.0.1').pathname
		const relative = urlPath.replace(/^\/+/u, '')
		const stripped = relative.startsWith('pages/') ? relative.slice('pages/'.length) : relative
		const filePath = path.resolve(PAGES_ROOT, stripped)
		if (!filePath.startsWith(PAGES_ROOT + path.sep) && filePath !== PAGES_ROOT) {
			response.writeHead(403)
			response.end('forbidden')
			return
		}
		try {
			const body = await readFile(filePath)
			response.writeHead(200, { 'Content-Type': MIME_BY_EXTENSION[path.extname(filePath)] || 'application/octet-stream' })
			response.end(body)
		}
		catch {
			response.writeHead(404)
			response.end('not found')
		}
	})
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
	const port = server.address().port
	return {
		port,
		/**
		 * @returns {Promise<void>}
		 */
		stop: () => new Promise(resolve => server.close(() => resolve())),
	}
}

test('frontend census page renders estimate via local chrome', async t => {
	const chromePath = await resolveLocalChrome()
	if (!chromePath) return t.skip('本机 PATH 上未找到 chrome/edge — 跳过前端测试')
	const { chromium } = await import('playwright-core')
	const server = await startStaticServer()
	/** @type {import('playwright-core').Browser | null} */
	let browser = null
	try {
		browser = await chromium.launch({ executablePath: chromePath, headless: true })
		const page = await browser.newPage()
		await page.goto(`http://127.0.0.1:${server.port}/pages/index.html?demo=1`)
		await page.waitForFunction(() => document.querySelector('#estimate')?.textContent === '200', null, { timeout: 10_000 })
		t.diagnostic(`chrome: ${chromePath}`)

		const estimate = await page.textContent('#estimate')
		const sampleSize = await page.textContent('#sample-size')
		const windowEvents = await page.textContent('#window-events')
		const status = await page.textContent('#status')
		assertEquals(estimate.trim(), '200', `estimate=${estimate}`)
		assertEquals(sampleSize.trim(), '20', `sampleSize=${sampleSize}`)
		assertEquals(windowEvents.trim(), '20', `windowEvents=${windowEvents}`)
		assertEquals(status.includes('演示模式'), true, `status=${status}`)

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
	}
})