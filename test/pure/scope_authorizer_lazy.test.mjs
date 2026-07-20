import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { assert } from '../helpers/assert.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '../..')
const childScript = join(here, '../helpers/scope_authorizer_lazy_child.mjs')

/**
 * @param {string} mode FOUNT_SCOPE_AUTH_LAZY_MODE
 * @returns {Promise<void>}
 */
async function runChild(mode) {
	const child = spawn(process.execPath, [childScript], {
		cwd: packageRoot,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: {
			...process.env,
			FOUNT_SCOPE_AUTH_LAZY_MODE: mode,
		},
		windowsHide: true,
	})
	const result = await new Promise(resolve => {
		let stdout = ''
		let stderr = ''
		const timer = setTimeout(() => {
			try { child.kill('SIGKILL') } catch { /* ignore */ }
			resolve({ kind: 'timeout', stdout, stderr })
		}, 15_000)
		child.stdout.setEncoding('utf8')
		child.stderr.setEncoding('utf8')
		child.stdout.on('data', chunk => { stdout += chunk })
		child.stderr.on('data', chunk => { stderr += chunk })
		child.once('exit', (code, signal) => {
			clearTimeout(timer)
			resolve({ kind: 'exit', code, signal, stdout, stderr })
		})
		child.once('error', error => {
			clearTimeout(timer)
			resolve({ kind: 'error', error, stdout, stderr })
		})
	})
	assert(result.kind === 'exit', `child did not exit: ${JSON.stringify(result)}`)
	assert(result.code === 0, `exit ${result.code} signal ${result.signal}\nstderr: ${result.stderr}`)
	assert(result.stdout.includes('ok'), `missing ok marker: ${result.stdout}`)
}

test('registerScopeAuthorizer does not require initNode', async () => {
	await runChild('register')
})

test('pending scope authorizer flushes on first getLinkRegistry', async () => {
	await runChild('flush')
})
