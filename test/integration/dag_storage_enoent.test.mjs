/**
 * dag/storage.mjs ENOENT 容错：cleanup 竞态下群目录已被删除，后台读流不应抛 unhandled error。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { readJsonl, readJsonlStream } from '../../dag/storage.mjs'
import { assertEquals } from '../helpers/assert.mjs'

test('readJsonl returns [] for missing file', async () => {
	const missing = join(mkdtempSync(join(tmpdir(), 'p2p-dag-')), 'nope.jsonl')
	assertEquals(await readJsonl(missing), [])
})

test('readJsonlStream silently yields nothing for missing file (no unhandled error)', async () => {
	const missing = join(mkdtempSync(join(tmpdir(), 'p2p-dag-')), 'gone.jsonl')
	const rows = []
	for await (const row of readJsonlStream(missing)) rows.push(row)
	assertEquals(rows, [])
})

test('readJsonlStream survives cleanup race: file deleted mid-iteration', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'p2p-dag-'))
	const path = join(dir, 'events.jsonl')
	writeFileSync(path, `${JSON.stringify({ id: 'a' })}\n${JSON.stringify({ id: 'b' })}\n`)
	const ids = []
	for await (const row of readJsonlStream(path)) ids.push(row.id)
	assertEquals(ids.sort(), ['a', 'b'])
	rmSync(path)
	const after = []
	for await (const row of readJsonlStream(path)) after.push(row)
	assertEquals(after, [])
	rmSync(dir, { recursive: true, force: true })
})

test('readJsonl skips torn trailing line and keeps prior rows', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'p2p-dag-'))
	const path = join(dir, 'events.jsonl')
	await writeFile(path, `${JSON.stringify({ id: 'a' })}\n${JSON.stringify({ id: 'b' })}\n{"id":"c"`, 'utf8')
	assertEquals(await readJsonl(path), [{ id: 'a' }, { id: 'b' }])
	rmSync(dir, { recursive: true, force: true })
})
