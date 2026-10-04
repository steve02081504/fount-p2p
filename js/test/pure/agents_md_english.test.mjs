/**
 * AGENTS.md 与引用闭包 `.md`：须为英文、链接可解析；非 AGENTS.md 须在 docs/ 下。
 * 人类面向的 `docs/design/`、`docs/review/`、`docs/issues/`、`docs/readme/` 可为中文。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
	CJK_RE,
	isAgentsAuxDocPlacementOk,
	isAgentsMdBasename,
	isHumanFacingDocsPath,
	localMdLinkTargets,
	resolveMdLink,
	scanAgentsMdEnglish,
} from '../../scripts/checks/agents_md_english.mjs'
import { assert, assertEquals } from '../helpers/assert.mjs'

/** 仓库根（`js/` 的父目录，含 `kotlin/` 与根文档）。 */
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/**
 * 将 scan 问题格式化为断言可读字符串。
 * @param {{ path: string, lines: number[], missing?: boolean, placement?: boolean, from?: string }} issue 问题
 * @returns {string} 一行摘要
 */
function formatIssue(issue) {
	if (issue.missing) return `missing ${issue.path}${issue.from ? ` <- ${issue.from}` : ''}`
	if (issue.placement) return `placement ${issue.path}`
	return `${issue.path}:${issue.lines.join(',')}`
}

test('resolveMdLink handles repo-root and relative links', () => {
	assertEquals(resolveMdLink('AGENTS.md', 'js/docs/mesh.md'), 'js/docs/mesh.md')
	assertEquals(
		resolveMdLink('js/sim/AGENTS.md', '../docs/mesh.md'),
		'js/docs/mesh.md',
	)
	assertEquals(resolveMdLink('js/AGENTS.md', 'https://example.com/x.md'), null)
	assertEquals(resolveMdLink('js/AGENTS.md', 'mailto:a@b.com/x.md'), null)
	assertEquals(resolveMdLink('js/AGENTS.md', '//cdn.example/x.md'), null)
})

test('localMdLinkTargets parses bare, angle-bracket, titled, and fragment forms', () => {
	assertEquals(localMdLinkTargets('see [a](docs/a.md) and [b](docs/b.md#sec)'), [
		'docs/a.md',
		'docs/b.md',
	])
	assertEquals(localMdLinkTargets('see [a](<docs/a.md>) and [b](<docs/b.md#sec>)'), [
		'docs/a.md',
		'docs/b.md',
	])
	assertEquals(localMdLinkTargets('see [a](docs/a.md "Title") and [b](<docs/b.md#x> \'Alt\')'), [
		'docs/a.md',
		'docs/b.md',
	])
	assertEquals(localMdLinkTargets('skip [ext](https://example.com/x.md)'), [])
})

test('isAgentsAuxDocPlacementOk / isAgentsMdBasename', () => {
	assertEquals(isAgentsMdBasename('AGENTS.md'), true)
	assertEquals(isAgentsMdBasename('js/sim/agents.md'), true)
	assertEquals(isAgentsMdBasename('js/docs/notes.md'), false)
	assertEquals(isAgentsAuxDocPlacementOk('AGENTS.md'), true)
	assertEquals(isAgentsAuxDocPlacementOk('js/docs/mesh.md'), true)
	assertEquals(isAgentsAuxDocPlacementOk('kotlin/src/docs/spec.md'), true)
	assertEquals(isAgentsAuxDocPlacementOk('js/sim/cold_start.md'), false)
})

test('angle-bracket and titled .md links are discovered and scanned recursively', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'agents-md-links-'))
	try {
		await writeFile(join(dir, 'AGENTS.md'), [
			'# Root',
			'',
			'See [angled](<nested/docs/guide.md#top>) and [titled](nested/docs/other.md "Other") and [bad](nested/loose.md).',
			'',
		].join('\n'), 'utf8')
		await mkdir(join(dir, 'nested', 'docs'), { recursive: true })
		await writeFile(join(dir, 'nested', 'docs', 'guide.md'), [
			'# Guide',
			'',
			'See [leaf](leaf.md).',
			'中文说明',
			'',
		].join('\n'), 'utf8')
		await writeFile(join(dir, 'nested', 'docs', 'other.md'), [
			'# Other',
			'',
			'See [missing](gone.md).',
			'',
		].join('\n'), 'utf8')
		await writeFile(join(dir, 'nested', 'docs', 'leaf.md'), '# Leaf\n', 'utf8')
		await writeFile(join(dir, 'nested', 'loose.md'), '# Loose\n', 'utf8')

		const { files, issues } = await scanAgentsMdEnglish(dir)
		assertEquals(issues.map(formatIssue).sort(), [
			'missing nested/docs/gone.md <- nested/docs/other.md',
			'nested/docs/guide.md:4',
			'placement nested/loose.md',
		].sort())
		assertEquals(files, [
			'AGENTS.md',
			'nested/docs/guide.md',
			'nested/docs/leaf.md',
			'nested/docs/other.md',
			'nested/loose.md',
		].sort())
	}
	finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test('isHumanFacingDocsPath', () => {
	assertEquals(isHumanFacingDocsPath('docs/design/emoji-pack-spec.md'), true)
	assertEquals(isHumanFacingDocsPath('docs/review/foo.md'), true)
	assertEquals(isHumanFacingDocsPath('docs/issues/part-hot-reload.md'), true)
	assertEquals(isHumanFacingDocsPath('docs/readme/Readme.zh-CN.md'), true)
	assertEquals(isHumanFacingDocsPath('docs/AGENTS.md'), false)
	assertEquals(isHumanFacingDocsPath('js/docs/mesh.md'), false)
})

test('CJK_RE matches CJK scripts', () => {
	assert(CJK_RE.test('中文'))
	assert(CJK_RE.test('ひらがな'))
	assert(CJK_RE.test('カタカナ'))
	assert(CJK_RE.test('한글'))
	assertEquals(CJK_RE.test('English … — ok'), false)
})

test('repo: AGENTS.md closure is English, links resolve, aux docs under docs/', async () => {
	const { issues } = await scanAgentsMdEnglish(REPO_ROOT)
	assertEquals(
		issues.map(formatIssue),
		[],
		issues.map(formatIssue).join('\n'),
	)
})
