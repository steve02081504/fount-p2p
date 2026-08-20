import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'


import { assertEquals } from '../helpers/assert.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPTS = ['scripts/check-imports.mjs', 'scripts/find-unused-exports.mjs']

/**
 * 运行一个 repo 工具脚本，直接校验 spawnSync 结果：无 spawn 错误、未被信号杀死，
 * 且退出码符合预期（check-imports 必须为 0；find-unused-exports 为启发式工具，正常扫描结果
 * 退出码为 0 或 2；退出码 1 保留给未捕获异常/SyntaxError 等运行失败，必须判定为失败）。
 * @param {string} script 相对 repo 根的脚本路径
 * @returns {void}
 */
function assertScriptRuns(script) {
	const result = spawnSync(process.execPath, [script], { cwd: ROOT, encoding: 'utf8' })
	assertEquals(result.error, undefined, `${script} failed to spawn: ${String(result.error?.message || result.error)}`)
	assertEquals(result.signal, null, `${script} was killed by signal ${result.signal}`)
	assertEquals(
		script.includes('find-unused-exports.mjs') ? result.status === 0 || result.status === 2 : result.status === 0,
		true,
		`${script} exited with status ${result.status}`,
	)
	const stderr = String(result.stderr || '')
	assertEquals(stderr.includes('Internal/process'), false, `${script} threw a stack trace:\n${stderr}`)
}

for (const script of SCRIPTS)
	test(`${script} runs without crashing`, () => assertScriptRuns(script))
