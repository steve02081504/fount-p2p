import { createServer } from 'node:http'

import { test } from 'node:test'
import WebSocket, { WebSocketServer } from 'ws'

import { assertEquals } from '../helpers/assert.mjs'
import {
	activeResourceDelta,
	heapUsedAfterGc,
	snapshotActiveResources,
} from '../helpers/leak_detect.mjs'
import { createNostrSendWorkload } from './fixtures/nostr_send_workload.mjs'

/**
 * 通用内存/连接泄漏检测测试。
 *
 * 目标：不绑定具体传输（这次 nostr、下次蓝牙、下下次 LAN），无论将来哪种传输“打开连接忘关闭”
 * 或“每轮保留对象不清”，这里都应抓到。两条通用信号：
 *  1. 活跃资源计数——连接/句柄开了没关会随操作次数线性增长（确定性，无需 GC）。
 *  2. 强制 GC 后的堆占用——对象被长期保留会随操作次数线性增长（--expose-gc 启用的强制 GC）。
 */

/**
 * 对给定 workload 跑若干轮，返回其导致的活跃资源净增长。
 * @param {(index: number) => Promise<void>} workload 每轮做一次开连接的“发送”
 * @param {number} iterations 轮数
 * @param {number} [warmup=5] 预热轮数
 * @returns {Promise<number>} 活跃资源净增长
 */
async function activeResourceGrowth(workload, iterations, warmup = 5) {
	for (let iterationIndex = 0; iterationIndex < warmup; iterationIndex++) await workload(iterationIndex)
	await new Promise(resolve => setTimeout(resolve, 50))
	const before = snapshotActiveResources()
	for (let iterationIndex = 0; iterationIndex < iterations; iterationIndex++) await workload(iterationIndex)
	await new Promise(resolve => setTimeout(resolve, 50))
	return activeResourceDelta(snapshotActiveResources(), before).total
}

test('repeated nostr sends do not grow active resources', async () => {
	const { workload, shutdown } = await createNostrSendWorkload()
	try {
		const growth = await activeResourceGrowth(workload, 50)
		assertEquals(growth <= 4, true, `active resources grew by ${growth} across 50 sends`)
	}
	finally {
		await shutdown?.()
	}
})

test('detector flags sockets that are opened but never closed', async () => {
	const server = createServer()
	const wss = new WebSocketServer({ server })
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
	const port = typeof server.address() === 'object' && server.address() ? server.address().port : 0
	/** @type {import('ws').WebSocket[]} */
	const leaked = []
	try {
		await new Promise(resolve => setTimeout(resolve, 50))
		const before = snapshotActiveResources()
		for (let connectionIndex = 0; connectionIndex < 10; connectionIndex++)
			await new Promise((resolve, reject) => {
				const ws = new WebSocket(`ws://127.0.0.1:${port}`)
				leaked.push(ws)
				ws.once('open', resolve)
				ws.once('error', reject)
			})
		await new Promise(resolve => setTimeout(resolve, 50))
		const { total } = activeResourceDelta(snapshotActiveResources(), before)
		assertEquals(total >= 5, true, `leaked sockets should grow resources, got ${total}`)
	}
	finally {
		for (const ws of leaked) try { ws.terminate() } catch { /* ignore */ }
		await new Promise(resolve => wss.close(() => resolve()))
		await new Promise(resolve => server.close(() => resolve()))
	}
})

test('repeated nostr sends keep forced-GC heap bounded', async () => {
	const { workload, shutdown } = await createNostrSendWorkload()
	try {
		for (let iterationIndex = 0; iterationIndex < 20; iterationIndex++) await workload(iterationIndex) // 预热：让一次性初始化先落地
		const baseline = await heapUsedAfterGc()
		for (let batchIndex = 0; batchIndex < 3; batchIndex++)
			for (let iterationIndex = 0; iterationIndex < 200; iterationIndex++) await workload(iterationIndex)
		// 稳态下累积堆增长应有界；若每 send 保留对象，增长会随批累积而线性超阈。
		const growth = (await heapUsedAfterGc()) - baseline
		assertEquals(growth < 512 * 1024, true,
			`cumulative heap grew by ${growth} bytes across 3 batches; a retained-per-send leak is suspected`)
	}
	finally {
		await shutdown?.()
	}
})

test('detector flags retained objects via cumulative heap growth', async () => {
	const retained = []
	try {
		const baseline = await heapUsedAfterGc()
		for (let iterationIndex = 0; iterationIndex < 200; iterationIndex++)
			retained.push(Array(1024).fill(0))
		// 200 × 1024 数字数组强制引用保留：稳态 GC 后仍被持有，堆应明显增长。
		const growth = (await heapUsedAfterGc()) - baseline
		assertEquals(growth > 512 * 1024, true,
			`retained arrays should grow heap by > 512KiB, got ${growth}`)
	}
	finally {
		retained.length = 0
	}
})
