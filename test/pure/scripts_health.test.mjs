import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { test } from 'node:test'

import { assertEquals } from '../helpers/assert.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPTS = ['scripts/check-imports.mjs', 'scripts/find-unused-exports.mjs']

/**
 * 运行一个 repo 工具脚本，断言它能正常执行（不因语法/运行时错误崩溃）。
 * 注意：find-unused-exports 是启发式工具，可能因“存在未使用导出”而返回非零；这里只校验它
 * “跑得起来、不崩”，而不是要求零退出码。
 * @param {string} script 相对 repo 根的脚本路径
 * @returns {void}
 */
function assertScriptRuns(script) {
	const result = spawnSync(process.execPath, [script], { cwd: ROOT, encoding: 'utf8' })
	const stderr = String(result.stderr || '')
	const crashed = /SyntaxError|TypeError|ReferenceError|Invalid regular expression/u.test(stderr)
	assertEquals(crashed, false, `${script} crashed:\n${stderr}`)
	assertEquals(stderr.includes('Internal/process'), false, `${script} threw a stack trace:\n${stderr}`)
}

for (const script of SCRIPTS)
	test(`${script} runs without crashing`, () => assertScriptRuns(script))
