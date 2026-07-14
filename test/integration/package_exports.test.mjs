import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PKG_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const pkg = JSON.parse(await readFile(path.join(PKG_ROOT, 'package.json'), 'utf8'))

/**
 * 解析 package.json exports（含通配符）。
 * @param {string} subpath 子路径（带 `./` 前缀）
 * @returns {string | null} 包内相对文件路径；无匹配时 null
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

/**
 * 按 package.json export 子路径动态导入模块。
 * @param {string} subpath package.json export 子路径（带 `./` 前缀）
 * @returns {Promise<Record<string, unknown>>} 动态导入的模块命名空间
 */
async function importExport(subpath) {
	const target = resolveExportTarget(subpath)
	assert(target, `missing export ${subpath}`)
	return import(pathToFileURL(path.join(PKG_ROOT, target)).href)
}

test('package exports resolve to loadable modules', async () => {
	const samples = [
		'.',
		'./crypto',
		'./crypto/channel',
		'./discovery',
		'./dag',
		'./permissions',
		'./core/hexIds',
		'./transport/link_registry',
		'./registries/event_type',
		'./registries/room_provider',
		'./wire/part_ingress',
		'./wire/part_query',
		'./schemas/mailbox',
		'./schemas/part_query',
		'./timeline/append_core',
		'./node/reputation_store',
		'./reputation/engine',
		'./trust_graph/resolve',
		'./mailbox/importance',
		'./governance/branch',
	]
	for (const subpath of samples) {
		const mod = await importExport(subpath)
		assert.equal(typeof mod, 'object', subpath)
	}
})
