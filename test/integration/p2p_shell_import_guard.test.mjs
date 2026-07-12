import { strict as assert } from 'node:assert'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const P2P_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))

/**
 * 递归遍历目录下所有 .mjs 文件。
 * @param {string} dir 起始目录
 * @returns {AsyncGenerator<{ path: string }>} 各 .mjs 文件的绝对路径
 */
async function* walkMjs(dir) {
	for (const name of await readdir(dir)) {
		const entry = path.join(dir, name)
		const info = await stat(entry)
		if (info.isDirectory()) {
			if (name === 'node_modules' || name === '.git') continue
			yield* walkMjs(entry)
		}
		else if (name.endsWith('.mjs')) yield { path: entry }
	}
}

/**
 * 判断相对 import 是否逃出包根目录（生产代码不得引用 shell 路径）。
 * @param {string} spec import 说明符
 * @param {string} fromFile 引用方绝对路径
 * @returns {boolean} 逃出包根为 true
 */
function importEscapesPackageRoot(spec, fromFile) {
	if (!spec.startsWith('.')) return false
	const resolved = path.resolve(path.dirname(fromFile), spec)
	const rel = path.relative(P2P_ROOT, resolved)
	return rel.startsWith('..') || path.isAbsolute(rel)
}

test('p2p production code import boundary', async () => {
	/** @type {string[]} */
	const violations = []
	for await (const entry of walkMjs(P2P_ROOT)) {
		if (entry.path.includes(`${path.sep}test${path.sep}`)) continue
		if (entry.path.includes(`${path.sep}sim${path.sep}`)) continue
		if (entry.path.includes(`${path.sep}scripts${path.sep}`)) continue
		const text = await readFile(entry.path, 'utf8')
		const rel = path.relative(P2P_ROOT, entry.path)
		if (/\bsocial_rpc\b/u.test(text))
			violations.push(`${rel}: social_rpc literal`)
		if (/getShellPartpath\(\s*['"]social['"]\s*\)/u.test(text))
			violations.push(`${rel}: getShellPartpath('social')`)
		if (/fount:chat:/u.test(text))
			violations.push(`${rel}: fount:chat: literal`)
		if (/fount:chat:agent:/u.test(text))
			violations.push(`${rel}: fount:chat:agent: literal`)
		if (/\bagentEntityHash\b/u.test(text))
			violations.push(`${rel}: agentEntityHash literal`)
		for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/gu)) {
			const spec = match[1]
			if (spec.includes('public/parts/shells'))
				violations.push(`${rel} -> ${spec} (shell parts)`)
			if (spec.includes('shells/social'))
				violations.push(`${rel} -> ${spec} (shells/social)`)
			if (/^(?:\.\.\/)*server\//u.test(spec) || spec.startsWith('fount/server/'))
				violations.push(`${rel} -> ${spec} (server)`)
			if (importEscapesPackageRoot(spec, entry.path))
				violations.push(`${rel} -> ${spec} (escapes package root)`)
		}
	}
	assert.deepEqual(violations, [])
})
