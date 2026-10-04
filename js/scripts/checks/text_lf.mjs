/**
 * 仓库 UTF-8 文本文件须使用 LF 换行（禁止 CRLF / 孤立 CR）。
 * 其余文本恰以一个 LF 结尾（0 个或多于 1 个均错误）；
 * 仅单行 .svg（忽略结尾 LF 后不含 LF）不得以 LF 结尾。
 * 开头不得为 LF（开头检查先跳过 UTF-8 BOM）。
 * 判定文本：整文件可 fatal UTF-8 解码，且不含 NUL 或 C0 控制字节（制表 / LF / CR 除外）；空文件豁免。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { argv, exit } from 'node:process'
import { fileURLToPath } from 'node:url'

import { listRepoFiles } from './walk.mjs'

/** js/ 包根（本检查器所在仓库的根）。 */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const utf8Fatal = new TextDecoder('utf-8', { fatal: true })

/**
 * 读取文件字节；文件不存在返回 null。
 * @param {string} absolutePath 绝对路径
 * @returns {Promise<Uint8Array | null>} 字节
 */
async function readTextFile(absolutePath) {
	try {
		return new Uint8Array(await readFile(absolutePath))
	}
	catch (error) {
		if (error?.code === 'ENOENT') return null
		throw error
	}
}

/**
 * 取 UTF-8 BOM 的字节长度（无 BOM 为 0）。
 * @param {Uint8Array} bytes 文件原始字节
 * @returns {number} BOM 长度（0 或 3）
 */
function bomLength(bytes) {
	return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
}

/**
 * @typedef {'crlf' | 'cr' | 'mixed'} TextNonLfKind 非 LF 换行种类
 */

/**
 * @typedef {'crlf' | 'cr' | 'mixed' | 'no-final-newline' | 'extra-final-newlines' | 'unexpected-final-newline' | 'leading-newline'} TextLfIssueKind
 * 命中种类：非 LF 换行 / 结尾 LF 数量不符 / 单行 .svg 带结尾 LF / 开头（跳过 BOM 后）为 LF
 */

/**
 * @typedef {{ path: string, kind: TextLfIssueKind }} TextLfIssue 命中条目
 */

/**
 * 是否为可检查的 UTF-8 文本（无 NUL / C0 控制字节、fatal 解码成功）。
 * @param {Uint8Array} bytes 文件原始字节
 * @returns {boolean} 是文本则为 true
 */
export function isUtf8Text(bytes) {
	for (const byte of bytes)
		if (byte < 0x09 || (byte > 0x0a && byte < 0x0d) || (byte > 0x0d && byte < 0x20)) return false
	try {
		utf8Fatal.decode(bytes)
		return true
	}
	catch {
		return false
	}
}

/**
 * 检测字节内容中的非 LF 换行。
 * @param {Uint8Array} bytes 文件原始字节
 * @returns {TextNonLfKind | null} 非 LF 则为种类，否则 null
 */
export function detectNonLfLineEndings(bytes) {
	let crlf = false
	let loneCr = false
	for (let index = 0; index < bytes.length; index++) {
		if (bytes[index] !== 13) continue
		if (bytes[index + 1] === 10) crlf = true
		else loneCr = true
	}
	if (crlf && loneCr) return 'mixed'
	if (crlf) return 'crlf'
	if (loneCr) return 'cr'
	return null
}

/**
 * 统计文件结尾连续 LF 的数量。
 * @param {Uint8Array} bytes 文件原始字节
 * @returns {number} 结尾连续 LF 个数
 */
function countTrailingLf(bytes) {
	let count = 0
	for (let index = bytes.length - 1; index >= 0 && bytes[index] === 10; index--) count++
	return count
}

/**
 * 检测文件结尾连续 LF 的数量类别。
 * @param {Uint8Array} bytes 文件原始字节
 * @returns {'none' | 'single' | 'multiple'} 结尾 LF 数量类别
 */
export function detectFinalNewline(bytes) {
	const count = countTrailingLf(bytes)
	if (count === 0) return 'none'
	if (count === 1) return 'single'
	return 'multiple'
}

/**
 * 检测文件开头（跳过 UTF-8 BOM 后）是否为 LF。
 * @param {Uint8Array} bytes 文件原始字节
 * @returns {boolean} 开头为 LF 则为 true
 */
export function detectLeadingLf(bytes) {
	const start = bomLength(bytes)
	return start < bytes.length && bytes[start] === 10
}

/**
 * 扫描单文件（调用方已确认是 UTF-8 文本）。
 * @param {string} relativePath 相对仓库根
 * @param {Uint8Array} bytes 文件原始字节
 * @returns {TextLfIssue[]} 命中的问题列表（空数组表示合规）
 */
export function scanFileTextLf(relativePath, bytes) {
	if (!bytes.length) return []
	/** @type {TextLfIssue[]} */
	const issues = []
	const kind = detectNonLfLineEndings(bytes)
	if (kind) issues.push({ path: relativePath, kind })
	const trailingLf = countTrailingLf(bytes)
	const lfFree = !bytes.subarray(0, bytes.length - trailingLf).includes(10)
	if (lfFree && relativePath.toLowerCase().endsWith('.svg')) {
		if (trailingLf > 0) issues.push({ path: relativePath, kind: 'unexpected-final-newline' })
	}
	else if (trailingLf === 0)
		issues.push({ path: relativePath, kind: 'no-final-newline' })
	else if (trailingLf > 1)
		issues.push({ path: relativePath, kind: 'extra-final-newlines' })
	if (detectLeadingLf(bytes)) issues.push({ path: relativePath, kind: 'leading-newline' })
	return issues
}

/**
 * 修复单文件为合规换行（调用方已确认是 UTF-8 文本）。
 * 归一化 CRLF/孤立 CR 为 LF、去掉开头（跳过 BOM 后）LF、
 * 结尾恰一个 LF（单行 .svg 则去掉结尾 LF；全空则保持空）。
 * @param {string} relativePath 相对仓库根
 * @param {Uint8Array} bytes 文件原始字节
 * @returns {Uint8Array | null} 修复后的字节；原字节已合规则 null
 */
export function fixFileTextLf(relativePath, bytes) {
	if (!bytes.length) return null
	const bom = bomLength(bytes)
	/** @type {number[]} */
	const body = []
	for (let index = bom; index < bytes.length; index++) {
		const byte = bytes[index]
		if (byte === 13) {
			body.push(10)
			if (bytes[index + 1] === 10) index++
		}
		else body.push(byte)
	}
	while (body[0] === 10) body.shift()
	if (body.length) {
		while (body[body.length - 1] === 10) body.pop()
		const lfFree = !body.includes(10)
		if (!(lfFree && relativePath.toLowerCase().endsWith('.svg'))) body.push(10)
	}
	const fixed = new Uint8Array(bom + body.length)
	if (bom) fixed.set([0xef, 0xbb, 0xbf])
	fixed.set(body, bom)
	if (fixed.length === bytes.length && fixed.every((byte, index) => byte === bytes[index])) return null
	return fixed
}

/**
 * 扫描仓库中 UTF-8 文本文件的换行（只读）。
 * @param {string} [repoRoot=PACKAGE_ROOT] 仓库根
 * @returns {Promise<{ files: string[], issues: TextLfIssue[] }>} 扫描到的问题路径与列表
 */
export async function scanTextLf(repoRoot = PACKAGE_ROOT) {
	/** @type {TextLfIssue[]} */
	const issues = []
	for (const relativePath of await listRepoFiles(repoRoot)) {
		const bytes = await readTextFile(join(repoRoot, relativePath))
		if (!bytes || !isUtf8Text(bytes)) continue
		issues.push(...scanFileTextLf(relativePath, bytes))
	}
	return { files: [...new Set(issues.map(issue => issue.path))].sort(), issues }
}

/**
 * 扫描并自动修复仓库中 UTF-8 文本文件的换行问题。
 * @param {string} [repoRoot=PACKAGE_ROOT] 仓库根
 * @returns {Promise<string[]>} 被改写的相对路径（正斜杠、已排序）
 */
export async function fixTextLf(repoRoot = PACKAGE_ROOT) {
	/** @type {string[]} */
	const fixed = []
	for (const relativePath of await listRepoFiles(repoRoot)) {
		const bytes = await readTextFile(join(repoRoot, relativePath))
		if (!bytes || !isUtf8Text(bytes)) continue
		const fixedBytes = fixFileTextLf(relativePath, bytes)
		if (!fixedBytes) continue
		await writeFile(join(repoRoot, relativePath), fixedBytes)
		fixed.push(relativePath)
	}
	return fixed.sort()
}

/** 命令行入口：`node scripts/checks/text_lf.mjs [--fix] [root]`。 */
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href
if (isMain) {
	const fix = argv.includes('--fix')
	const rootArgument = argv.slice(2).find(argument => !argument.startsWith('--'))
	const repoRoot = rootArgument ? resolve(rootArgument) : PACKAGE_ROOT
	if (fix) {
		const fixed = await fixTextLf(repoRoot)
		if (!fixed.length) console.log('无换行问题')
		else {
			console.log(`自动修复 ${fixed.length} 个文件的换行:`)
			for (const path of fixed) console.log(`  ${path}`)
		}
	}
	else {
		const { issues } = await scanTextLf(repoRoot)
		for (const issue of issues) console.log(`${issue.path} (${issue.kind})`)
		console.log(`共 ${issues.length} 个问题`)
		exit(issues.length ? 1 : 0)
	}
}
