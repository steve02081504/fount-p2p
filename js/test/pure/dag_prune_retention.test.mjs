import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'


import { topologicalCanonicalOrder } from '../../dag/index.mjs'
import {
	descendantClosureFromTip,
} from '../../governance/branch.mjs'
import { computeRetentionKeepIds } from '../../node/retention_policy.mjs'
import {
	clearEventTypeRegistry,
	getPermissionAnchorTypes,
	registerEventTypeDefs,
} from '../../registries/event_type.mjs'
import { pruneEventsJsonlAfterCheckpoint } from '../../timeline/prune.mjs'
import { enforceTimelineEventRetention } from '../../timeline/retention.mjs'
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
	const dir = await mkdtemp(join(tmpdir(), 'p2p-prune-retention-'))
	try {
		await testFn(dir)
	}
	finally {
		await rm(dir, { recursive: true, force: true })
	}
}

/**
 * 去掉本地扩展字段的 sanitize（模拟会丢字段的规范化）。
 * @param {object} row 原始行
 * @returns {object} 净化后的行（丢弃 receivedAt/isRemote）
 */
function strippingSanitize(row) {
	const { receivedAt, isRemote, ...rest } = row
	return rest
}

test('descendantClosureFromTip keeps connected suffix not topo slice orphans', () => {
	const root = hex('0')
	const left = hex('1')
	const right = hex('2')
	const tip = hex('3')
	const orphan = hex('4')
	const events = [
		{ id: tip, prev_event_ids: [left, right] },
		{ id: orphan, prev_event_ids: [left] },
		{ id: left, prev_event_ids: [root] },
		{ id: right, prev_event_ids: [root] },
		{ id: root, prev_event_ids: [] },
	]
	const byId = new Map(events.map(e => [e.id, e]))
	const keep = descendantClosureFromTip(tip, byId)
	assertEquals(keep.has(tip), true)
	assertEquals(keep.has(orphan), false)
	assertEquals(keep.size, 1)
})

test('computeRetentionKeepIds depth retains ancestor chain on branch', () => {
	const e1 = hex('1')
	const e2 = hex('2')
	const e3 = hex('3')
	const e4 = hex('4')
	const events = [
		{ id: e1, type: 'message', prev_event_ids: [], hlc: { wall: 1, logical: 0 } },
		{ id: e2, type: 'message', prev_event_ids: [e1], hlc: { wall: 2, logical: 0 } },
		{ id: e3, type: 'message', prev_event_ids: [e2], hlc: { wall: 3, logical: 0 } },
		{ id: e4, type: 'message', prev_event_ids: [e3], hlc: { wall: 4, logical: 0 } },
	]
	const byId = new Map(events.map(e => [e.id, e]))
	const order = topologicalCanonicalOrder(events)
	const keep = computeRetentionKeepIds(order, byId, {
		maxDepth: 2,
		cutoffWall: 0,
		anchorTypes: getPermissionAnchorTypes(),
		branchTipId: e4,
	})
	assertEquals(keep.size, 4)
})

test('prune keeps retained row raw bytes with stripping sanitize', async () => {
	await withTempDir(async dir => {
		const path = join(dir, 'events.jsonl')
		const tip = hex('3')
		const dropped = hex('4')
		const keptRaw = `{"id":"${tip}","prev_event_ids":[],"hlc":{"wall":2,"logical":0},"receivedAt":123,"isRemote":true}`
		const droppedRaw = JSON.stringify({ id: dropped, prev_event_ids: [], hlc: { wall: 1, logical: 0 } })
		await writeFile(path, `${keptRaw}\n${droppedRaw}\n`, 'utf8')
		const result = await pruneEventsJsonlAfterCheckpoint(path, { checkpoint_event_id: tip }, strippingSanitize)
		assertEquals(result, { pruned: true, kept: 1, dropped: 1 })
		const text = await readFile(path, 'utf8')
		assertEquals(text, `${keptRaw}\n`)
	})
})

test('retention keeps retained row raw bytes with stripping sanitize', async () => {
	clearEventTypeRegistry()
	registerEventTypeDefs('prune-retention-test', { group_create: { permissionAnchor: true, governance: true } })
	try {
		await withTempDir(async dir => {
			const path = join(dir, 'events.jsonl')
			const anchor = hex('1')
			const dropped = hex('2')
			const keptRaw = `{"id":"${anchor}","type":"group_create","prev_event_ids":[],"hlc":{"wall":2,"logical":0},"receivedAt":456,"isRemote":false}`
			const droppedRaw = JSON.stringify({ id: dropped, type: 'message', prev_event_ids: [], hlc: { wall: 0, logical: 0 } })
			await writeFile(path, `${keptRaw}\n${droppedRaw}\n`, 'utf8')
			const result = await enforceTimelineEventRetention(path, null, {
				maxDepth: 256,
				maxMs: 3_600_000,
				anchorTypes: getPermissionAnchorTypes(),
			}, strippingSanitize)
			assertEquals(result.pruned, true)
			assertEquals(result.dropped, 1)
			const text = await readFile(path, 'utf8')
			assertEquals(text.includes(keptRaw), true)
			assertEquals(text.includes('receivedAt'), true)
		})
	}
	finally {
		clearEventTypeRegistry()
	}
})
