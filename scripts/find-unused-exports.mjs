/**
 * 死导出扫描：列出包源码中没有任何引用方（包内 / test / sim / 可选 fount 跨仓）的具名导出。
 *
 * 用法：node scripts/find-unused-exports.mjs [--fount <fount仓库路径>]
 *
 * 判定为启发式：导出名在其他文件里以标识符出现即视为「被使用」（宁可漏报不误报）。
 * `export * from` 的转发不产生新名字，facade 重导出不影响判定。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKIP_DIRS = new Set(['node_modules', '.git', 'debug_logs'])
/** 包源码之外的目录（其中的导出不检查，但其中的引用算数） */
const NON_PACKAGE_DIRS = new Set(['test', 'sim', 'scripts'])

const fountFlagIndex = process.argv.indexOf('--fount')
const fountRoot = fountFlagIndex >= 0 ? process.argv[fountFlagIndex + 1] : null
if (fountFlagIndex >= 0 && (!fountRoot || !existsSync(fountRoot))) {
	console.error('--fount path missing or does not exist')
	process.exit(2)
}

/**
 * 递归收集目录下所有 .mjs 文件。
 * @param {string} dir 起始目录
 * @returns {string[]} 绝对路径列表
 */
function walk(dir) {
	/** @type {string[]} */
	const out = []
	for (const name of readdirSync(dir)) {
		const p = join(dir, name)
		if (statSync(p).isDirectory()) {
			if (SKIP_DIRS.has(name)) continue
			out.push(...walk(p))
		}
		else if (name.endsWith('.mjs')) out.push(p)
	}
	return out
}

/**
 * 提取一个模块的具名导出（function / class / const / let / export {...} 列表）。
 * @param {string} text 源码
 * @returns {string[]} 导出名
 */
function namedExportsOf(text) {
	/** @type {Set<string>} */
	const names = new Set()
	for (const m of text.matchAll(/^export\s+(?:async\s+)?(?:function\s*\*?|class|const|let)\s+([$A-Z_a-z][\w$]*)/gmu))
		names.add(m[1])
	for (const m of text.matchAll(/^export\s*{([^}]*)}/gmu))
		for (const piece of m[1].split(',')) {
			const name = piece.split(/\s+as\s+/u).pop()?.trim()
			if (name && name !== 'default') names.add(name)
		}
	return [...names]
}

const repoFiles = walk(ROOT)
const packageFiles = repoFiles.filter(file => {
	const rel = file.slice(ROOT.length + 1)
	return !NON_PACKAGE_DIRS.has(rel.split(/[/\\]/u)[0])
})

/** @type {Array<{ file: string, text: string }>} 引用侧全集：本仓 + 可选 fount */
const referenceCorpus = repoFiles.map(file => ({ file, text: readFileSync(file, 'utf8') }))
if (fountRoot)
	for (const file of walk(fountRoot))
		referenceCorpus.push({ file, text: readFileSync(file, 'utf8') })

/** @type {Map<string, string[]>} file → 未被引用的导出名 */
const unusedByFile = new Map()
for (const file of packageFiles) {
	const text = readFileSync(file, 'utf8')
	for (const name of namedExportsOf(text)) {
		const pattern = new RegExp(`\\b${name}\\b`, 'u')
		const used = referenceCorpus.some(entry => entry.file !== file && pattern.test(entry.text))
		if (used) continue
		const rel = file.slice(ROOT.length + 1)
		if (!unusedByFile.has(rel)) unusedByFile.set(rel, [])
		unusedByFile.get(rel).push(name)
	}
}

if (!unusedByFile.size) {
	console.log('No unused exports found.')
	process.exit(0)
}
let total = 0
for (const [file, names] of [...unusedByFile].sort(([a], [b]) => a.localeCompare(b))) {
	console.log(file)
	for (const name of names.sort()) {
		console.log(`  ${name}`)
		total++
	}
}
console.log(`\n${total} unused export(s) in ${unusedByFile.size} file(s).`)
process.exit(1)
