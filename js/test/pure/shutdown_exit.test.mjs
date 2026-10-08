import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { assert } from '../helpers/assert.mjs'
import { startFakeRelay } from '../helpers/fake_relay.mjs'

/** init → ensureRuntime → shutdown 后子进程须自然退出 */
const COLD_EXIT_BUDGET_MS = 10_000
/** 暖机后再 shutdown：shutdown 标记起至进程退出 */
const WARM_MS = 10_000
const WARM_EXIT_BUDGET_MS = 2_000

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '../..')
const childScript = join(here, '../helpers/shutdown_exit_child.mjs')

/**
 * 读子进程 stdout 里 `relay-count <n>` 行的计数（`relay-count` 不含 `shutdown`，不会提前触发计量）。
 * @param {string} stdout 子进程累计输出
 * @returns {number} 子进程真正连过的 relay 条数
 */
function parseRelayCount(stdout) {
	return Number(stdout.match(/^relay-count (\d+)$/m)?.[1] ?? 0)
}

/**
 * 在父进程起的本地假 relay 上跑一轮 `init → ensureRuntime → shutdown`，计量 shutdown→exit。
 * 公网 relay 会让判定随网络往返漂移，故子进程的 nostr 通道钉到这个本地 relay。
 * @param {string} relayUrl 本地假 relay 的 `ws://127.0.0.1:<port>` 地址
 * @param {{ warmMs?: number, afterShutdownBudgetMs: number }} options 暖机与 shutdown→exit 预算
 * @returns {Promise<{ afterShutdownMs: number, relayCount: number }>} 实测退出耗时与实际连过的 relay 条数
 */
async function runShutdownExitChild(relayUrl, options) {
	const warmMs = Math.max(0, Number(options.warmMs) || 0)
	const { afterShutdownBudgetMs } = options
	const child = spawn(process.execPath, [childScript, String(warmMs), relayUrl], {
		cwd: packageRoot,
		stdio: ['ignore', 'pipe', 'ignore'],
		windowsHide: true,
	})
	const result = await new Promise(resolve => {
		let shutdownAt = null
		let stdout = ''
		const hardCap = warmMs + afterShutdownBudgetMs + 5_000
		const hardTimer = setTimeout(() => {
			try { child.kill('SIGKILL') } catch { /* ignore */ }
			resolve({ kind: 'timeout', shutdownAt, stdout })
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
			resolve({ kind: 'exit', code, signal, shutdownAt, afterShutdownMs, stdout })
		})
		child.once('error', error => {
			clearTimeout(hardTimer)
			resolve({ kind: 'error', error, stdout })
		})
	})
	assert(result.kind === 'exit', `process did not exit: ${JSON.stringify(result)}`)
	assert(result.code === 0, `exit code ${result.code} signal ${result.signal}`)
	assert(result.shutdownAt != null, 'child never signaled shutdown')
	assert(
		result.afterShutdownMs < afterShutdownBudgetMs,
		`shutdown→exit ${result.afterShutdownMs.toFixed(1)}ms >= ${afterShutdownBudgetMs}ms`,
	)
	return { afterShutdownMs: result.afterShutdownMs, relayCount: parseRelayCount(result.stdout) }
}

/**
 * 跑一轮并断言子进程只碰了它被钉住的那个 relay（连过的 relay 数量不可能超过 1；冷启动可能一个都没连上）。
 * @param {{ warmMs?: number, afterShutdownBudgetMs: number }} options 暖机与 shutdown→exit 预算
 * @returns {Promise<void>}
 */
async function assertShutdownExitsWithin(options) {
	const relay = await startFakeRelay(() => true)
	try {
		const { relayCount } = await runShutdownExitChild(`ws://127.0.0.1:${relay.port}`, options)
		assert(relayCount <= 1, `the child contacted ${relayCount} relays although only the local one is configured`)
	}
	finally { await relay.stop() }
}

test('ensureRuntime + shutdown: process exits within 10s', async () => {
	await assertShutdownExitsWithin({ afterShutdownBudgetMs: COLD_EXIT_BUDGET_MS })
})

test('ensureRuntime + warm 10s + shutdown: process exits within 2s', async () => {
	await assertShutdownExitsWithin({ warmMs: WARM_MS, afterShutdownBudgetMs: WARM_EXIT_BUDGET_MS })
})
