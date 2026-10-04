/**
 * 扫描源码中违反「JSDoc 摘要禁用纯英文」的块（含拉丁字母、无 CJK，或缺摘要）。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { CJK_RE } from './agents_md_english.mjs'
import { listRepoFiles } from './walk.mjs'

/** 源码后缀。 */
export const JSDOC_SCAN_SUFFIXES = ['.mjs', '.js', '.ts']

/** 摘要行视为「无描述」的 @ 标签前缀。 */
const TAG_ONLY_PREFIX = /^@(typedef|type|template|property|augments|extends|implements|memberof|see|link|example|default|deprecated|ignore|internal|private|protected|public|readonly|override|inheritdoc|satisfies|import)\b/

const ASCII_LETTER_RE = /[A-Za-z]/

/**
 * 从源码文本中提取 JSDoc 块（含起始行号）。
 * 单趟跟踪字符串 / 模板字面量 / 注释上下文（含模板插值嵌套），只收 `/**` 开头的注释，跳过其内的伪 JSDoc。
 * @param {string} text 源码
 * @returns {{ text: string, startLine: number }[]} 块列表
 */
export function extractJsdocBlocks(text) {
	/** @type {{ text: string, startLine: number }[]} */
	const blocks = []
	/** 每行的起始偏移（用于把块起点换算成行号）。 */
	const lineStarts = [0]
	for (let newline = text.indexOf('\n'); newline >= 0; newline = text.indexOf('\n', newline + 1)) lineStarts.push(newline + 1)
	/** 模板插值外层的上下文栈。 */
	const stack = []
	/** @type {'' | 'block' | 'line' | '"' | '\'' | '`'} */
	let state = ''
	for (let index = 0; index < text.length;) {
		if (state === 'line') {
			if (text[index] !== '\n') { index++; continue }
			state = stack.pop() ?? ''
			index++
			continue
		}
		if (state === 'block') {
			if (!text.startsWith('*/', index)) { index++; continue }
			state = stack.pop() ?? ''
			index += 2
			continue
		}
		if (state === '"' || state === '\'' || state === '`') {
			if (text[index] === '\\') { index += 2; continue }
			if (state === '`' && text.startsWith('${', index)) { stack.push(state); state = ''; index += 2; continue }
			if (text[index] === state) { state = stack.pop() ?? ''; index++; continue }
			index++
			continue
		}
		if (text.startsWith('/**', index)) {
			const end = text.indexOf('*/', index + 3)
			if (end < 0) break
			blocks.push({ text: text.slice(index, end + 2), startLine: lineStarts.findLastIndex(lineStart => lineStart <= index) + 1 })
			index = end + 2
			continue
		}
		if (text.startsWith('/*', index) || text.startsWith('//', index)) {
			state = text[index + 1] === '*' ? 'block' : 'line'
			index += 2
			continue
		}
		if (text[index] === '"' || text[index] === '\'' || text[index] === '`') {
			state = text[index]
			index++
			continue
		}
		if (text[index] === '}' && stack.length) { state = stack.pop(); index++; continue }
		index++
	}
	return blocks
}

/**
 * 取 JSDoc 块在首个 `@tag` 之前的摘要行（去 `*` 前缀）。
 * @param {string} block JSDoc 块全文
 * @returns {string[]} 非空摘要行
 */
export function jsdocSummaryLines(block) {
	const inner = block.slice(3, -2)
	const lines = []
	for (const raw of inner.split(/\r?\n/)) {
		const trimmed = raw.replace(/^\s*\*\s?/, '').trim()
		if (!trimmed) continue
		if (trimmed.startsWith('@')) break
		lines.push(trimmed)
	}
	return lines
}

/**
 * 摘要是否算「纯英文」：有拉丁字母、无 CJK，且非空。
 * @param {string[]} summaryLines 摘要行
 * @returns {boolean} 摘要是否为纯英文
 */
export function isEnglishJsdocSummary(summaryLines) {
	if (!summaryLines.length) return false
	const text = summaryLines.join(' ')
	if (!ASCII_LETTER_RE.test(text)) return false
	if (CJK_RE.test(text)) return false
	return true
}

/**
 * 块是否仅有类型/标签、无人类可读摘要。
 * 空块或无任何允许标签的块不算 tag-only。
 * @param {string} block JSDoc 块
 * @returns {boolean} 是否仅有类型/标签且无人类可读摘要
 */
export function isTagOnlyJsdoc(block) {
	const summary = jsdocSummaryLines(block)
	if (summary.length) return false
	let sawPermittedTag = false
	const inner = block.slice(3, -2)
	for (const raw of inner.split(/\r?\n/)) {
		const trimmed = raw.replace(/^\s*\*\s?/, '').trim()
		if (!trimmed || !trimmed.startsWith('@')) continue
		if (TAG_ONLY_PREFIX.test(trimmed) || /^@(param|returns?|throws?|yields?)\b/.test(trimmed)) {
			sawPermittedTag = true
			continue
		}
		return false
	}
	return sawPermittedTag
}

/**
 * 多行 JSDoc 是否在开头同行就写了内容（应让开头的星号注释独立成行）。
 * 单行块不受约束。
 * @param {string} block JSDoc 块全文
 * @returns {boolean} 多行且首行开注释符后有内容则为 true
 */
export function hasInlineJsdocOpening(block) {
	if (!block.startsWith('/**')) return false
	const body = block.slice(3)
	const newlineIndex = body.search(/\r?\n/)
	if (newlineIndex < 0) return false
	return body.slice(0, newlineIndex).trim() !== ''
}

/**
 * 多行 JSDoc 是否把结尾星号斜杠写在内容行上（应换行缩进后再收尾）。
 * 单行块不受约束。
 * @param {string} block JSDoc 块全文
 * @returns {boolean} 多行且未前置换行缩进收尾则为 true
 */
export function hasInlineJsdocClosing(block) {
	if (!block.startsWith('/**') || !block.endsWith('*/')) return false
	if (!/\r?\n/.test(block)) return false
	return !/\n\s+$/.test(block.slice(0, -2))
}

/**
 * @typedef {{ path: string, line: number, summary: string, missingSummary: boolean }} JsdocNoEnglishIssue
 */

/**
 * @typedef {{ path: string, line: number }} JsdocOpeningIssue
 */

/**
 * @typedef {{ path: string, line: number }} JsdocClosingIssue
 */

/**
 * @typedef {JsdocNoEnglishIssue | JsdocOpeningIssue | JsdocClosingIssue} JsdocIssue
 */

/**
 * 扫描仓库中匹配后缀的文件；返回命中的文件与问题。
 * @param {string} repoRoot 仓库根
 * @param {string[]} suffixes 后缀
 * @param {(relativePath: string, text: string) => JsdocIssue[]} scanFile 单文件扫描器
 * @returns {Promise<{ files: string[], issues: JsdocIssue[] }>} 命中文件路径与问题列表
 */
async function scanRepoJsdoc(repoRoot, suffixes, scanFile) {
	/** @type {JsdocIssue[]} */
	const issues = []
	for (const relativePath of await listRepoFiles(repoRoot, suffixes))
		issues.push(...scanFile(relativePath, await readFile(join(repoRoot, relativePath), 'utf8')))
	return { files: [...new Set(issues.map(issue => issue.path))].sort(), issues }
}

/**
 * 扫描单文件中的纯英文 / 缺摘要 JSDoc。
 * @param {string} relativePath 相对仓库根
 * @param {string} text 文件内容
 * @returns {JsdocNoEnglishIssue[]} 命中列表
 */
export function scanFileJsdocNoEnglish(relativePath, text) {
	/** @type {JsdocNoEnglishIssue[]} */
	const issues = []
	for (const { text: block, startLine } of extractJsdocBlocks(text)) {
		const summary = jsdocSummaryLines(block)
		const missingSummary = summary.length === 0 && !isTagOnlyJsdoc(block)
		if (isEnglishJsdocSummary(summary))
			issues.push({ path: relativePath, line: startLine, summary: summary.join(' '), missingSummary: false })
		else if (missingSummary)
			issues.push({ path: relativePath, line: startLine, summary: '', missingSummary: true })
	}
	return issues
}

/**
 * 扫描仓库中匹配后缀的文件。
 * @param {string} repoRoot 仓库根
 * @param {string[]} [suffixes=JSDOC_SCAN_SUFFIXES] 后缀
 * @returns {Promise<{ files: string[], issues: JsdocIssue[] }>} 命中文件路径与问题列表
 */
export async function scanJsdocNoEnglish(repoRoot, suffixes = JSDOC_SCAN_SUFFIXES) {
	return scanRepoJsdoc(repoRoot, suffixes, scanFileJsdocNoEnglish)
}

/**
 * 扫描单文件中「多行 JSDoc 开注释符同行带内容」的块。
 * @param {string} relativePath 相对仓库根
 * @param {string} text 文件内容
 * @returns {JsdocOpeningIssue[]} 命中列表
 */
export function scanFileJsdocOpening(relativePath, text) {
	/** @type {JsdocOpeningIssue[]} */
	const issues = []
	for (const { text: block, startLine } of extractJsdocBlocks(text))
		if (hasInlineJsdocOpening(block))
			issues.push({ path: relativePath, line: startLine })
	return issues
}

/**
 * 扫描仓库中匹配后缀文件的「多行 JSDoc 开注释符同行带内容」问题。
 * @param {string} repoRoot 仓库根
 * @param {string[]} [suffixes=JSDOC_SCAN_SUFFIXES] 后缀
 * @returns {Promise<{ files: string[], issues: JsdocIssue[] }>} 命中文件路径与问题列表
 */
export async function scanJsdocOpening(repoRoot, suffixes = JSDOC_SCAN_SUFFIXES) {
	return scanRepoJsdoc(repoRoot, suffixes, scanFileJsdocOpening)
}

/**
 * 扫描单文件中「多行 JSDoc 的收尾写在内容行上」的块。
 * @param {string} relativePath 相对仓库根
 * @param {string} text 文件内容
 * @returns {JsdocClosingIssue[]} 命中列表
 */
export function scanFileJsdocClosing(relativePath, text) {
	/** @type {JsdocClosingIssue[]} */
	const issues = []
	for (const { text: block, startLine } of extractJsdocBlocks(text))
		if (hasInlineJsdocClosing(block))
			issues.push({ path: relativePath, line: startLine })
	return issues
}

/**
 * 扫描仓库中匹配后缀文件的「多行 JSDoc 收尾写在内容行上」问题。
 * @param {string} repoRoot 仓库根
 * @param {string[]} [suffixes=JSDOC_SCAN_SUFFIXES] 后缀
 * @returns {Promise<{ files: string[], issues: JsdocIssue[] }>} 命中文件路径与问题列表
 */
export async function scanJsdocClosing(repoRoot, suffixes = JSDOC_SCAN_SUFFIXES) {
	return scanRepoJsdoc(repoRoot, suffixes, scanFileJsdocClosing)
}
