/**
 * dag/storage.mjs ENOENT 容错：cleanup 竞态下群目录已被删除，后台读流不应抛 unhandled error。
 */
import { rmSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { readJsonl, readJsonlStream } from '../../dag/storage.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { mkTestNodeDir, teardownTestNodeDir } from '../helpers/node_dir_leak.mjs'

test('readJsonl returns [] for missing file', async () => {
	const nodeDir = await mkTestNodeDir('p2p-dag-')
	const missing = join(nodeDir, 'nope.jsonl')
	assertEquals(await readJsonl(missing), [])
	await teardownTestNodeDir(nodeDir)
})

test('readJsonlStream silently yields nothing for missing file (no unhandled error)', async () => {
	const nodeDir = await mkTestNodeDir('p2p-dag-')
	const missing = join(nodeDir, 'gone.jsonl')
	const rows = []
	for await (const row of readJsonlStream(missing)) rows.push(row)
	assertEquals(rows, [])
	await teardownTestNodeDir(nodeDir)
})

test('readJsonlStream survives cleanup race: file deleted mid-iteration', async () => {
	const nodeDir = await mkTestNodeDir('p2p-dag-')
	const path = join(nodeDir, 'events.jsonl')
	writeFileSync(path, `${JSON.stringify({ id: 'a' })}\n${JSON.stringify({ id: 'b' })}\n`)
	const ids = []
	for await (const row of readJsonlStream(path)) ids.push(row.id)
	assertEquals(ids.sort(), ['a', 'b'])
	rmSync(path)
	const after = []
	for await (const row of readJsonlStream(path)) after.push(row)
	assertEquals(after, [])
	await teardownTestNodeDir(nodeDir)
})

test('readJsonl skips torn trailing line and keeps prior rows', async () => {
	const nodeDir = await mkTestNodeDir('p2p-dag-')
	const path = join(nodeDir, 'events.jsonl')
	await writeFile(path, `${JSON.stringify({ id: 'a' })}\n${JSON.stringify({ id: 'b' })}\n{"id":"c"`, 'utf8')
	assertEquals(await readJsonl(path), [{ id: 'a' }, { id: 'b' }])
	await teardownTestNodeDir(nodeDir)
})
