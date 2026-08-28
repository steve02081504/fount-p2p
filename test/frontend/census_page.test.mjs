import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { resolveLocalChrome } from '../helpers/local_chrome.mjs'

const P2P_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))

const MIME_BY_EXTENSION = {
	'.html': 'text/html; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
}

/**
 * 静态服务仓库根目录（仅限 pages/ 下文件，离线可跑）。
 * @returns {Promise<{ port: number, stop: () => Promise<void> }>}
 */
async function startStaticServer() {
	const server = createServer(async (request, response) => {
		const urlPath = new URL(request.url, 'http://127.0.0.1').pathname
		const relative = urlPath.replace(/^\/+/u, '')
		const filePath = path.resolve(P2P_ROOT, relative)
		if (!filePath.startsWith(P2P_ROOT + path.sep) && filePath !== P2P_ROOT) {
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
		if (estimate.trim() !== '200') throw new Error(`estimate=${estimate}`)
		if (sampleSize.trim() !== '20') throw new Error(`sampleSize=${sampleSize}`)
		if (windowEvents.trim() !== '20') throw new Error(`windowEvents=${windowEvents}`)
		if (!status.includes('演示模式')) throw new Error(`status=${status}`)

		await page.uncheck('#toggle')
		const offEstimate = await page.textContent('#estimate')
		if (offEstimate.trim() !== '0') throw new Error(`off estimate=${offEstimate}`)

		await page.check('#toggle')
		await page.waitForFunction(() => document.querySelector('#estimate')?.textContent === '200', null, { timeout: 10_000 })
	}
	finally {
		await browser?.close()
		await server.stop()
	}
})