import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * 壳层（fount social / cabinet）依赖的公开子路径与符号。
 * 误删或改名会让此测试失败，避免再 silent break 壳层。
 */
const SHELL_CONTRACT = [
	{
		subpath: './wire/part/fanout',
		exports: [
			'collectPartInvokeResponses',
			'partInvokeDataRows',
			'partInvokeErrorMessages',
			'PART_INVOKE_FANOUT_DEFAULT',
		],
	},
	{
		subpath: './wire/part/ingress',
		exports: [
			'attachPartWire',
			'handleIncomingPartInvokeRequest',
			'handleIncomingPartInvokeFireAndForget',
		],
	},
	{
		subpath: './wire/part/invoke',
		exports: [
			'isPartInvoke',
			'isPartInvokeResponse',
			'unwrapPartInvokeResult',
		],
	},
	{
		subpath: './wire/part/pending',
		exports: [
			'pendingPartInvoke',
			'handleIncomingPartInvokeResponse',
		],
	},
]

const PKG_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const pkg = JSON.parse(await readFile(path.join(PKG_ROOT, 'package.json'), 'utf8'))

/**
 * @param {string} subpath package export 子路径
 * @returns {string | null} 目标相对路径
 */
function resolveExportTarget(subpath) {
	const exact = pkg.exports[subpath]
	if (exact) return exact
	for (const [pattern, target] of Object.entries(pkg.exports)) {
		const star = pattern.indexOf('*')
		if (star < 0) continue
		const prefix = pattern.slice(0, star)
		const suffix = pattern.slice(star + 1)
		if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue
		const captured = subpath.slice(prefix.length, subpath.length - suffix.length)
		if (!captured || captured.includes('/')) continue
		return target.replace('*', captured)
	}
	return null
}

test('shell part_invoke contract exports stay loadable', async () => {
	for (const entry of SHELL_CONTRACT) {
		const target = resolveExportTarget(entry.subpath)
		assert(target, `missing package export ${entry.subpath}`)
		const mod = await import(pathToFileURL(path.join(PKG_ROOT, target)).href)
		for (const name of entry.exports)
			assert.notEqual(mod[name], undefined, `${entry.subpath} must export ${name}`)
	}
})

test('attachPartWire registers part_invoke_response collector', async () => {
	const text = await readFile(path.join(PKG_ROOT, 'wire/part/ingress.mjs'), 'utf8')
	assert.match(text, /part_invoke_response/)
	assert.match(text, /handleIncomingPartInvokeResponse/)
})
