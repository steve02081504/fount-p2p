/**
 * dag/storage.mjs rewriteJsonlKeeping：原子重写、原始行无损保留、与 append 共用互斥锁、
 * 失败时原文件保持不变、缺失源不复活目录。
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { test } from 'node:test'

import {
	appendJsonlSynced,
	jsonlMutexKey,
	readJsonlTipId,
	rewriteJsonlKeeping,
} from '../../dag/storage.mjs'
import { activeMutexCount } from '../../utils/async_mutex.mjs'
import { assert, assertEquals } from '../helpers/assert.mjs'
import { mkTestNodeDir, teardownTestNodeDir } from '../helpers/node_dir_leak.mjs'

/**
 * @param {object[]} rows 行对象
 * @returns {string} JSONL 文本
 */
function linesOf(rows) {
	return rows.map(row => `${JSON.stringify(row)}\n`).join('')
}

/**
 * @param {string} path 文件路径
 * @returns {object[]} 解析后的行对象
 */
function readRows(path) {
	return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
}

/**
 * @param {string} directory 目录
 * @returns {string[]} 残留的原子临时文件
 */
function tempFiles(directory) {
	return readdirSync(directory).filter(name => name.includes('.tmp.'))
}

test('rewriteJsonlKeeping filters rows and reports counts', async () => {
	const nodeDir = await mkTestNodeDir('p2p-dag-rewrite-')
	try {
		const path = join(nodeDir, 'events.jsonl')
		writeFileSync(path, linesOf([{ id: 'a' }, { id: 'b' }, { id: 'c' }]))
		const result = await rewriteJsonlKeeping(path, row => row.id !== 'b')
		assertEquals(result, { kept: 2, dropped: 1 })
		assertEquals(readRows(path), [{ id: 'a' }, { id: 'c' }])
	}
	finally {
		await teardownTestNodeDir(nodeDir)
	}
})

test('rewriteJsonlKeeping serializes with appendJsonlSynced', async () => {
	const nodeDir = await mkTestNodeDir('p2p-dag-rewrite-')
	try {
		const path = join(nodeDir, 'events.jsonl')
		writeFileSync(path, linesOf([{ id: 'a' }]))
		/** @type {() => void} */
		let releaseGate = () => { }
		const gate = new Promise(resolveGate => { releaseGate = resolveGate })
		/** @type {() => void} */
		let signalEntered = () => { }
		const entered = new Promise(resolveEntered => { signalEntered = resolveEntered })
		const rewritePromise = rewriteJsonlKeeping(path, async () => {
			signalEntered()
			await gate
			return true
		})
		await entered
		let appendDone = false
		const appendPromise = appendJsonlSynced(path, { id: 'b' }).then(() => { appendDone = true })
		await new Promise(resolve => setTimeout(resolve, 20))
		assertEquals(appendDone, false)
		releaseGate()
		await Promise.all([rewritePromise, appendPromise])
		assertEquals(readRows(path), [{ id: 'a' }, { id: 'b' }])
	}
	finally {
		await teardownTestNodeDir(nodeDir)
	}
})

test('rewriteJsonlKeeping leaves original untouched when keep throws', async () => {
	const nodeDir = await mkTestNodeDir('p2p-dag-rewrite-')
	try {
		const path = join(nodeDir, 'events.jsonl')
		const original = linesOf([{ id: 'a' }, { id: 'b' }])
		writeFileSync(path, original)
		let calls = 0
		await assert.rejects(
			() => rewriteJsonlKeeping(path, () => {
				calls++
				if (calls === 2) throw new Error('keep boom')
				return true
			}),
			/keep boom/,
		)
		assertEquals(readFileSync(path, 'utf8'), original)
		assertEquals(tempFiles(nodeDir), [])
	}
	finally {
		await teardownTestNodeDir(nodeDir)
	}
})

test('rewriteJsonlKeeping is a no-op (bytes and mtime) when nothing dropped', async () => {
	const nodeDir = await mkTestNodeDir('p2p-dag-rewrite-')
	try {
		const path = join(nodeDir, 'events.jsonl')
		const original = '{"id": "a"}\n'
		writeFileSync(path, original)
		const before = statSync(path)
		const result = await rewriteJsonlKeeping(path, () => true)
		assertEquals(result, { kept: 1, dropped: 0 })
		assertEquals(readFileSync(path, 'utf8'), original)
		assertEquals(statSync(path).mtimeMs, before.mtimeMs)
		assertEquals(tempFiles(nodeDir), [])
	}
	finally {
		await teardownTestNodeDir(nodeDir)
	}
})

test('rewriteJsonlKeeping empties the file when all rows are dropped', async () => {
	const nodeDir = await mkTestNodeDir('p2p-dag-rewrite-')
	try {
		const path = join(nodeDir, 'events.jsonl')
		writeFileSync(path, linesOf([{ id: 'a' }, { id: 'b' }]))
		const result = await rewriteJsonlKeeping(path, () => false)
		assertEquals(result, { kept: 0, dropped: 2 })
		assertEquals(statSync(path).size, 0)
	}
	finally {
		await teardownTestNodeDir(nodeDir)
	}
})

test('rewriteJsonlKeeping does not create file or directory for missing source', async () => {
	const nodeDir = await mkTestNodeDir('p2p-dag-rewrite-')
	try {
		const nested = join(nodeDir, 'nested')
		const path = join(nested, 'events.jsonl')
		const result = await rewriteJsonlKeeping(path, () => true)
		assertEquals(result, { kept: 0, dropped: 0 })
		assertEquals(existsSync(path), false)
		assertEquals(existsSync(nested), false)
	}
	finally {
		await teardownTestNodeDir(nodeDir)
	}
})

test('rewriteJsonlKeeping writes back the original raw line despite sanitize', async () => {
	const nodeDir = await mkTestNodeDir('p2p-dag-rewrite-')
	try {
		const path = join(nodeDir, 'events.jsonl')
		const original = `${JSON.stringify({ id: 'a', extra: 'keep-me' })}\n`
		writeFileSync(path, original)
		const result = await rewriteJsonlKeeping(path, row => row.extra === undefined, {
			/**
			 * @param {Record<string, unknown>} row 原始行
			 * @returns {Record<string, unknown>} 去除 extra 的副本
			 */
			sanitize: row => {
				const copy = { ...row }
				delete copy.extra
				return copy
			},
		})
		assertEquals(result, { kept: 1, dropped: 0 })
		assertEquals(readFileSync(path, 'utf8'), original)
	}
	finally {
		await teardownTestNodeDir(nodeDir)
	}
})

test('rewriteJsonlKeeping removes invalid lines and prevents the no-op shortcut', async () => {
	const nodeDir = await mkTestNodeDir('p2p-dag-rewrite-')
	try {
		const path = join(nodeDir, 'events.jsonl')
		writeFileSync(path, `${JSON.stringify({ id: 'a' })}\nnot json at all\n`)
		const result = await rewriteJsonlKeeping(path, () => true)
		assertEquals(result, { kept: 1, dropped: 1 })
		assertEquals(readFileSync(path, 'utf8'), `${JSON.stringify({ id: 'a' })}\n`)
	}
	finally {
		await teardownTestNodeDir(nodeDir)
	}
})

test('jsonlMutexKey normalizes relative and absolute paths', async () => {
	const nodeDir = await mkTestNodeDir('p2p-dag-rewrite-')
	try {
		const absolute = join(nodeDir, 'events.jsonl')
		writeFileSync(absolute, linesOf([{ id: 'a' }]))
		const rel = relative(process.cwd(), absolute)
		assertEquals(jsonlMutexKey(absolute), jsonlMutexKey(rel))
		assertEquals(jsonlMutexKey(absolute), `jsonl:${resolve(absolute)}`)
		const baseline = activeMutexCount()
		await rewriteJsonlKeeping(absolute, () => true)
		await appendJsonlSynced(absolute, { id: 'b' })
		assertEquals(activeMutexCount(), baseline)
	}
	finally {
		await teardownTestNodeDir(nodeDir)
	}
})

test('readJsonlTipId skips a torn line and returns the last valid id', async () => {
	const nodeDir = await mkTestNodeDir('p2p-dag-rewrite-')
	try {
		const path = join(nodeDir, 'events.jsonl')
		writeFileSync(path, `${JSON.stringify({ id: 'a' })}\n{"id":"torn"\n${JSON.stringify({ id: 'b' })}\n`)
		assertEquals(await readJsonlTipId(path), 'b')
	}
	finally {
		await teardownTestNodeDir(nodeDir)
	}
})

test('readJsonlTipId returns null for a wholly unparseable tail chunk', async () => {
	const nodeDir = await mkTestNodeDir('p2p-dag-rewrite-')
	try {
		const path = join(nodeDir, 'events.jsonl')
		writeFileSync(path, '{"id":"torn"')
		assertEquals(await readJsonlTipId(path), null)
	}
	finally {
		await teardownTestNodeDir(nodeDir)
	}
})
