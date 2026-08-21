/**
 * writeJsonFile 固定 `.tmp` 竞态：重叠写同一路径时后 rename 会 ENOENT。
 * 覆盖 entity_store / personal_block 等同路径重写场景。
 */
import { join } from 'node:path'
import { test } from 'node:test'

import { readJsonFile, writeJsonFile, writeJsonFileSync } from '../../utils/json_io.mjs'
import { assert, assertEquals } from '../helpers/assert.mjs'
import { mkTestNodeDir, teardownTestNodeDir } from '../helpers/node_dir_leak.mjs'

test('writeJsonFile concurrent rewrites of the same path do not ENOENT', async () => {
	const nodeDir = await mkTestNodeDir('p2p-json-io-')
	const filePath = join(nodeDir, 'personal_block.json')
	try {
		await writeJsonFile(filePath, { blocked: [] })
		const writers = 64
		const results = await Promise.allSettled(
			Array.from({ length: writers }, (_, i) =>
				writeJsonFile(filePath, { blocked: [{ scope: 'entity', value: String(i).padStart(128, 'a') }] })),
		)
		const failures = results.filter(r => r.status === 'rejected').map(r =>
			/** @type {PromiseRejectedResult} */ r.reason?.code || String(/** @type {PromiseRejectedResult} */ r.reason))
		assertEquals(failures, [])
		const data = await readJsonFile(filePath)
		assert.ok(data && Array.isArray(data.blocked))
		assertEquals(data.blocked.length, 1)
	}
	finally {
		await teardownTestNodeDir(nodeDir)
	}
})

test('writeJsonFileSync sequential rewrite keeps valid JSON', async () => {
	const nodeDir = await mkTestNodeDir('p2p-json-io-sync-')
	const filePath = join(nodeDir, 'personal_block.json')
	try {
		writeJsonFileSync(filePath, { blocked: [] })
		for (let i = 0; i < 20; i++)
			writeJsonFileSync(filePath, { blocked: [{ i }] })
		assertEquals(await readJsonFile(filePath), { blocked: [{ i: 19 }] })
	}
	finally {
		await teardownTestNodeDir(nodeDir)
	}
})
