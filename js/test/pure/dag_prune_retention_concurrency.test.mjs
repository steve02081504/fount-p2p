/**
 * prune / retention 的锁内读-算-写回归：并发 append 落在读与写之间时不得丢失。
 *
 * 手工持有 `jsonlMutexKey(path)` 锁后启动 prune（不 await），在持锁期间用
 * `appendFileSync` 绕过互斥直接追加（模拟另一个持有者写入落盘），随即释放锁；
 * 若 prune 在锁外读取，则读不到该追加行，回写时会把后代行丢掉；锁内读取则保留。
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { jsonlMutexKey } from '../../dag/storage.mjs'
import { clearEventTypeRegistry, registerEventTypeDefs } from '../../registries/event_type.mjs'
import { pruneEventsJsonlAfterCheckpoint } from '../../timeline/prune.mjs'
import { enforceTimelineEventRetention } from '../../timeline/retention.mjs'
import { withAsyncMutex } from '../../utils/async_mutex.mjs'
import { assertEquals } from '../helpers/assert.mjs'

/**
 * 构造固定长度十六进制串。
 * @param {string} c 重复字符
 * @returns {string} 64 字符测试哈希
 */
const hex = c => c.repeat(64)

/**
 * 在临时目录内运行测试并清理。
 * @param {(dir: string) => Promise<void>} testFn 测试函数
 * @returns {Promise<void>}
 */
async function withTempDir(testFn) {
	const dir = mkdtempSync(join(tmpdir(), 'p2p-prune-concurrency-'))
	try {
		await testFn(dir)
	}
	finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

/**
 * @param {string} path 文件路径
 * @returns {object[]} 解析后的行对象
 */
function readRows(path) {
	return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
}

test('prune keeps append that lands while another holder has the lock', async () => {
	await withTempDir(async dir => {
		const path = join(dir, 'events.jsonl')
		const tip = hex('1')
		const child = hex('2')
		writeFileSync(path, `${JSON.stringify({ id: tip, prev_event_ids: [], hlc: { wall: 1, logical: 0 } })}\n`)

		let prunePromise
		await withAsyncMutex(jsonlMutexKey(path), async () => {
			prunePromise = pruneEventsJsonlAfterCheckpoint(path, { checkpoint_event_id: tip })
			appendFileSync(path, `${JSON.stringify({ id: child, prev_event_ids: [tip], hlc: { wall: 2, logical: 0 } })}\n`)
		})
		const result = await prunePromise

		assertEquals(result, { pruned: false, kept: 2, dropped: 0 })
		const ids = readRows(path).map(row => row.id)
		assertEquals(ids.includes(tip), true)
		assertEquals(ids.includes(child), true)
	})
})

test('retention keeps append that lands while another holder has the lock', async () => {
	clearEventTypeRegistry()
	registerEventTypeDefs('prune-concurrency-test', { group_create: { permissionAnchor: true, governance: true } })
	try {
		await withTempDir(async dir => {
			const path = join(dir, 'events.jsonl')
			const anchor = hex('3')
			const stray = hex('5')
			const child = hex('4')
			const now = Date.now()
			writeFileSync(path, [
				JSON.stringify({ id: anchor, type: 'group_create', prev_event_ids: [], hlc: { wall: now, logical: 0 } }),
				JSON.stringify({ id: stray, type: 'message', prev_event_ids: [], hlc: { wall: 0, logical: 0 } }),
				'',
			].join('\n'))

			let retentionPromise
			await withAsyncMutex(jsonlMutexKey(path), async () => {
				retentionPromise = enforceTimelineEventRetention(path, null, {
					maxDepth: 256,
					maxMs: 3_600_000,
					anchorTypes: new Set(['group_create']),
				})
				appendFileSync(path, `${JSON.stringify({ id: child, type: 'message', prev_event_ids: [anchor], hlc: { wall: now, logical: 1 } })}\n`)
			})
			await retentionPromise

			const ids = readRows(path).map(row => row.id)
			assertEquals(ids.includes(anchor), true)
			assertEquals(ids.includes(child), true)
			assertEquals(ids.includes(stray), false)
		})
	}
	finally {
		clearEventTypeRegistry()
	}
})
