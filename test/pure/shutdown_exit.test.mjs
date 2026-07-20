import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { assert } from '../helpers/assert.mjs'

/** init → ensureRuntime → shutdown 后子进程须自然退出 */
const COLD_EXIT_BUDGET_MS = 10_000
/** 暖机后再 shutdown：shutdown 标记起至进程退出 */
const WARM_MS = 10_000
const WARM_EXIT_BUDGET_MS = 2_000

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '../..')
const childScript = join(here, '../helpers/shutdown_exit_child.mjs')

/**
 * @param {{ warmMs?: number, afterShutdownBudgetMs: number }} options 暖机与 shutdown→exit 预算
 * @returns {Promise<void>}
 */
async function assertShutdownExitsWithin(options) {
	const warmMs = Math.max(0, Number(options.warmMs) || 0)
	const afterShutdownBudgetMs = options.afterShutdownBudgetMs
	const child = spawn(process.execPath, [childScript], {
		cwd: packageRoot,
		stdio: ['ignore', 'pipe', 'ignore'],
		env: {
			...process.env,
			FOUNT_SHUTDOWN_EXIT_WARM_MS: String(warmMs),
		},
		windowsHide: true,
	})
	const result = await new Promise(resolve => {
		let shutdownAt = null
		let stdout = ''
		const hardCap = warmMs + afterShutdownBudgetMs + 5_000
		const hardTimer = setTimeout(() => {
			try { child.kill('SIGKILL') } catch { /* ignore */ }
			resolve({ kind: 'timeout', shutdownAt })
		}, hardCap)
		child.stdout.setEncoding('utf8')
		child.stdout.on('data', chunk => {
			stdout += chunk
			if (shutdownAt == null && stdout.includes('shutdown'))
				shutdownAt = performance.now()
		})
		child.once('exit', (code, signal) => {
			clearTimeout(hardTimer)
			const afterShutdownMs = shutdownAt == null ? null : performance.now() - shutdownAt
			resolve({ kind: 'exit', code, signal, shutdownAt, afterShutdownMs })
		})
		child.once('error', error => {
			clearTimeout(hardTimer)
			resolve({ kind: 'error', error })
		})
	})
	assert(result.kind === 'exit', `process did not exit: ${JSON.stringify(result)}`)
	assert(result.code === 0, `exit code ${result.code} signal ${result.signal}`)
	assert(result.shutdownAt != null, 'child never signaled shutdown')
	assert(
		result.afterShutdownMs < afterShutdownBudgetMs,
		`shutdown→exit ${result.afterShutdownMs.toFixed(1)}ms >= ${afterShutdownBudgetMs}ms`,
	)
}

test('ensureRuntime + shutdown: process exits within 10s', async () => {
	await assertShutdownExitsWithin({ afterShutdownBudgetMs: COLD_EXIT_BUDGET_MS })
})

test('ensureRuntime + warm 10s + shutdown: process exits within 2s', async () => {
	await assertShutdownExitsWithin({ warmMs: WARM_MS, afterShutdownBudgetMs: WARM_EXIT_BUDGET_MS })
})
