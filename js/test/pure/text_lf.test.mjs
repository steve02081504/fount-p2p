/**
 * 仓库 UTF-8 文本文件须使用 LF 换行（text_lf 检查）。
 * 单测各检测/修复函数，并对全仓做只读扫描断言 0 问题。
 */
import { test } from 'node:test'

import { assertEquals } from '../helpers/assert.mjs'
import {
	detectLeadingLf,
	detectNonLfLineEndings,
	fixFileTextLf,
	isUtf8Text,
	listRepoFiles,
	scanFileTextLf,
	scanTextLf,
} from '../../scripts/text_lf.mjs'

const encoder = new TextEncoder()

test('isUtf8Text: accepts plain UTF-8', () => {
	assertEquals(isUtf8Text(encoder.encode('hello\n中文')), true)
})

test('isUtf8Text: rejects NUL and invalid UTF-8', () => {
	assertEquals(isUtf8Text(new Uint8Array([0x61, 0x00, 0x62])), false)
	assertEquals(isUtf8Text(new Uint8Array([0xff, 0xfe])), false)
})

test('detectNonLfLineEndings: LF only', () => {
	assertEquals(detectNonLfLineEndings(encoder.encode('{\n"a": 1\n}')), null)
})

test('detectNonLfLineEndings: CRLF', () => {
	assertEquals(detectNonLfLineEndings(encoder.encode('{\r\n"a": 1\r\n}')), 'crlf')
})

test('detectNonLfLineEndings: lone CR', () => {
	assertEquals(detectNonLfLineEndings(encoder.encode('{\r"a": 1\r}')), 'cr')
})

test('detectNonLfLineEndings: mixed', () => {
	assertEquals(detectNonLfLineEndings(encoder.encode('{\r\n"a": 1\r}')), 'mixed')
})

test('detectLeadingLf', () => {
	assertEquals(detectLeadingLf(encoder.encode('\na')), true)
	assertEquals(detectLeadingLf(encoder.encode('\n\n')), true)
	assertEquals(detectLeadingLf(encoder.encode('a\n')), false)
	assertEquals(detectLeadingLf(new Uint8Array([])), false)
})

test('detectLeadingLf skips UTF-8 BOM', () => {
	const bom = new Uint8Array([0xef, 0xbb, 0xbf])
	assertEquals(detectLeadingLf(new Uint8Array([...bom, 10, ...encoder.encode('a')])), true)
	assertEquals(detectLeadingLf(new Uint8Array([...bom, ...encoder.encode('a')])), false)
})

test('scanFileTextLf: compliant files', () => {
	assertEquals(scanFileTextLf('ok.mjs', encoder.encode('a\nexport {}\n')), [])
	assertEquals(scanFileTextLf('empty.txt', new Uint8Array([])), [])
	assertEquals(scanFileTextLf('ok-bom.mjs', new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode('a\nb\n')])), [])
})

test('scanFileTextLf: non-LF and boundary issues', () => {
	assertEquals(scanFileTextLf('bad.mjs', encoder.encode('export {}\r\n'))[0].kind, 'crlf')
	assertEquals(scanFileTextLf('no-final.mjs', encoder.encode('a\nb'))[0].kind, 'no-final-newline')
	assertEquals(scanFileTextLf('extra-final.mjs', encoder.encode('a\nb\n\n'))[0].kind, 'extra-final-newlines')
	assertEquals(scanFileTextLf('leading.mjs', encoder.encode('\nexport {}\n'))[0].kind, 'leading-newline')
	assertEquals(
		scanFileTextLf('leading-bom.mjs', new Uint8Array([0xef, 0xbb, 0xbf, 10, ...encoder.encode('export {}')]))
			.map(issue => issue.kind)
			.sort(),
		['leading-newline', 'no-final-newline'],
	)
})

test('scanFileTextLf: single-line svg must not end with LF; other files need exactly one', () => {
	assertEquals(scanFileTextLf('icon.svg', encoder.encode('<svg></svg>')), [])
	assertEquals(scanFileTextLf('icon.svg', encoder.encode('<svg></svg>\n'))[0].kind, 'unexpected-final-newline')
	assertEquals(scanFileTextLf('icon.svg', encoder.encode('<svg></svg>\n\n'))[0].kind, 'unexpected-final-newline')
	assertEquals(scanFileTextLf('multi.svg', encoder.encode('<svg>\n<g></g>\n')), [])
	assertEquals(scanFileTextLf('single.txt', encoder.encode('abc'))[0].kind, 'no-final-newline')
	assertEquals(scanFileTextLf('single.txt', encoder.encode('abc\n')), [])
	assertEquals(scanFileTextLf('single.txt', encoder.encode('abc\n\n'))[0].kind, 'extra-final-newlines')
	assertEquals(
		scanFileTextLf('icon.svg', encoder.encode('<svg></svg>\n<g></g>'))[0].kind,
		'no-final-newline',
	)
	assertEquals(scanFileTextLf('multi.mjs', encoder.encode('a\nb'))[0].kind, 'no-final-newline')
	assertEquals(scanFileTextLf('multi.mjs', encoder.encode('a\nb\n')), [])
	assertEquals(scanFileTextLf('multi.mjs', encoder.encode('a\nb\n\n'))[0].kind, 'extra-final-newlines')
})

test('fixFileTextLf: compliant files return null', () => {
	assertEquals(fixFileTextLf('ok.mjs', encoder.encode('a\nexport {}\n')), null)
	assertEquals(fixFileTextLf('empty.txt', new Uint8Array([])), null)
	assertEquals(fixFileTextLf('icon.svg', encoder.encode('<svg></svg>')), null)
	assertEquals(
		fixFileTextLf('ok-bom.mjs', new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode('a\nb\n')])),
		null,
	)
})

test('fixFileTextLf: non-LF and boundary fixes', () => {
	assertEquals(fixFileTextLf('bad.mjs', encoder.encode('export {}\r\n')), encoder.encode('export {}\n'))
	assertEquals(fixFileTextLf('bad.mjs', encoder.encode('a\rb')), encoder.encode('a\nb\n'))
	assertEquals(fixFileTextLf('no-final.mjs', encoder.encode('a\nb')), encoder.encode('a\nb\n'))
	assertEquals(fixFileTextLf('extra-final.mjs', encoder.encode('a\nb\n\n')), encoder.encode('a\nb\n'))
	assertEquals(fixFileTextLf('leading.mjs', encoder.encode('\nexport {}\n')), encoder.encode('export {}\n'))
	assertEquals(
		fixFileTextLf('leading-bom.mjs', new Uint8Array([0xef, 0xbb, 0xbf, 10, ...encoder.encode('export {}')])),
		new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode('export {}\n')]),
	)
})

test('fixFileTextLf: single-line svg drops trailing LF; other files keep exactly one', () => {
	assertEquals(fixFileTextLf('icon.svg', encoder.encode('<svg></svg>\n')), encoder.encode('<svg></svg>'))
	assertEquals(fixFileTextLf('icon.svg', encoder.encode('<svg></svg>\n\n')), encoder.encode('<svg></svg>'))
	assertEquals(fixFileTextLf('multi.svg', encoder.encode('<svg>\n<g></g>\n')), null)
	assertEquals(fixFileTextLf('single.txt', encoder.encode('abc')), encoder.encode('abc\n'))
	assertEquals(fixFileTextLf('single.txt', encoder.encode('abc\n')), null)
	assertEquals(fixFileTextLf('single.txt', encoder.encode('abc\n\n')), encoder.encode('abc\n'))
	assertEquals(fixFileTextLf('icon.svg', encoder.encode('<svg></svg>\n<g></g>')), encoder.encode('<svg></svg>\n<g></g>\n'))
	assertEquals(fixFileTextLf('multi.mjs', encoder.encode('a\nb')), encoder.encode('a\nb\n'))
	assertEquals(fixFileTextLf('multi.mjs', encoder.encode('a\nb\n')), null)
	assertEquals(fixFileTextLf('multi.mjs', encoder.encode('a\nb\n\n')), encoder.encode('a\nb\n'))
})

test('repo: UTF-8 text files use LF, correct final LF, no leading LF', async () => {
	const files = await listRepoFiles()
	assertEquals(Array.isArray(files), true, 'listRepoFiles returns a path array')
	const { issues } = await scanTextLf()
	assertEquals(issues, [], `文本文件须使用 LF 换行、结尾 LF 符合规则且开头不为 LF (${issues.length}):\n${issues.slice(0, 12).map(issue => `${issue.path} (${issue.kind})`).join('\n')}`)
})
