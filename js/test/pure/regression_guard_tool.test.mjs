import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { assert, assertEquals } from '../helpers/assert.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '../..')
const repoRoot = join(packageRoot, '..')
const tool = join(packageRoot, 'scripts/check-regression-guard.mjs')

/** 那笔「共享 socket 监听器上限」修复，及其守它的测试 */
const FIXED_FILE = 'js/discovery/nostr/session.mjs'
const FIXED_TEST = 'js/test/pure/nostr_publish_listeners.test.mjs'

/**
 * @param {string[]} args git 参数
 * @returns {string | null} stdout（失败为 null）
 */
function git(args) {
	const result = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' })
	return result.status === 0 ? result.stdout.trim() : null
}

/**
 * 跑反证器。
 * @param {string[]} args 额外参数
 * @returns {{ status: number, stdout: string, stderr: string }} 运行结果
 */
function runGuard(args) {
	const result = spawnSync(process.execPath, [tool, '--revert', FIXED_FILE, '--tests', FIXED_TEST, ...args], {
		cwd: repoRoot,
		encoding: 'utf8',
	})
	return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** 修复该文件的提交；`null` 表示当前检出没有 git 历史（跑不了反证器） */
const fixCommit = git(['log', '-1', '--format=%H', '--', FIXED_FILE])

test('regression guard passes only when the test fails on the pre-fix code', { skip: fixCommit ? false : 'no git history for the guarded file' }, () => {
	const result = runGuard(['--base', `${fixCommit}^`])
	assertEquals(result.status, 0, `the tool must confirm the guard: ${result.stdout}${result.stderr}`)
	assert(result.stdout.includes('must fail'), 'the run is labelled with the expectation')
})

test('regression guard reports a test that passes on the code it claims to guard', { skip: fixCommit ? false : 'no git history for the guarded file' }, () => {
	// 基线取修复本身：代码里修复还在，测试自然通过，工具必须判它「没守住」。
	const result = runGuard(['--base', fixCommit])
	assertEquals(result.status, 1, `a non-guarding test must fail the tool: ${result.stdout}${result.stderr}`)
	assert(result.stderr.includes('still passes on the pre-fix code'), result.stderr)
})
