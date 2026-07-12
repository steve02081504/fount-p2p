import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 递归收集目录下所有 .mjs 文件。
 * @param {string} dir 起始目录
 * @returns {string[]} 相对 ROOT 的绝对路径列表
 */
function walk(dir) {
	/** @type {string[]} */
	const out = []
	for (const name of readdirSync(dir)) {
		const p = join(dir, name)
		if (statSync(p).isDirectory()) {
			if (name === 'node_modules' || name === '.git') continue
			out.push(...walk(p))
		}
		else if (name.endsWith('.mjs')) out.push(p)
	}
	return out
}

/**
 * 将相对 import 说明符解析为磁盘上的 .mjs 或 index.mjs 路径。
 * @param {string} from 引用方文件路径
 * @param {string} spec 相对 import 说明符
 * @returns {string | null} 解析成功返回绝对路径，否则 null
 */
function resolveSpec(from, spec) {
	if (!spec.startsWith('.')) return null
	let resolved = normalize(join(dirname(from), spec))
	if (!existsSync(resolved))
		if (existsSync(`${resolved}.mjs`)) resolved = `${resolved}.mjs`
		else if (existsSync(join(resolved, 'index.mjs'))) resolved = join(resolved, 'index.mjs')

	return existsSync(resolved) ? resolved : null
}

/** @type {string[]} */
const broken = []
for (const file of walk(ROOT)) {
	if (file.includes(`${join('node_modules', '')}`)) continue
	const text = readFileSync(file, 'utf8')
	for (const m of text.matchAll(/(?:from|import)\s*(?:\(\s*)?['"](\.[^'"]+)['"]/g)) {
		const spec = m[1]
		if (!spec.endsWith('.mjs') && !spec.endsWith('.json')) continue
		const target = resolveSpec(file, spec)
		if (!target || !existsSync(target))
			broken.push(`${file.slice(ROOT.length + 1)} -> ${spec}`)
	}
}

if (broken.length) {
	console.error('Broken imports:')
	for (const b of broken) console.error(' ', b)
	process.exit(1)
}
console.log('All relative imports resolve.')
