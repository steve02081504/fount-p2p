import { createServer } from 'node:http'

import { test } from 'node:test'
import WebSocket, { WebSocketServer } from 'ws'

import { assertEquals } from '../helpers/assert.mjs'
import {
	activeResourceDelta,
	heapUsedAfterGc,
	snapshotActiveResources,
} from '../helpers/leak_detect.mjs'

/**
 * 通用内存/连接泄漏检测测试。
 *
 * 目标：不绑定具体传输（这次 nostr、下次蓝牙、下下次 LAN），无论将来哪种传输“打开连接忘关闭”
 * 或“每轮保留对象不清”，这里都应抓到。两条通用信号：
 *  1. 活跃资源计数——连接/句柄开了没关会随操作次数线性增长（确定性，无需 GC）。
 *  2. 强制 GC 后的堆占用——对象被长期保留会随操作次数线性增长（运行时启用的强制 GC）。
 */

/**
 * 对给定 workload 跑若干轮，返回其导致的活跃资源净增长。
 * @param {(index: number) => Promise<void>} workload 每轮做一次开连接的“发送”
 * @param {number} iterations 轮数
 * @param {number} [warmup=5] 预热轮数
 * @returns {Promise<number>} 活跃资源净增长
 */
async function activeResourceGrowth(workload, iterations, warmup = 5) {
	for (let i = 0; i < warmup; i++) await workload(i)
	await new Promise(resolve => setTimeout(resolve, 50))
	const before = snapshotActiveResources()
	for (let i = 0; i < iterations; i++) await workload(i)
	await new Promise(resolve => setTimeout(resolve, 50))
	return activeResourceDelta(snapshotActiveResources(), before).total
}

test('repeated nostr sends do not grow active resources', async () => {
	const { workload, shutdown } = await import('./fixtures/nostr_send_workload.mjs')
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
		for (let i = 0; i < 10; i++)
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
	const { workload, shutdown } = await import('./fixtures/nostr_send_workload.mjs')
	try {
		for (let i = 0; i < 20; i++) await workload(i) // 预热：让一次性初始化先落地
		const perBatchGrowth = []
		for (let batch = 0; batch < 3; batch++) {
			const before = await heapUsedAfterGc()
			for (let i = 0; i < 200; i++) await workload(i)
			perBatchGrowth.push((await heapUsedAfterGc()) - before)
		}
		// 稳态下每批只留少量稳态余量；若每 send 保留对象，增长会随批累积而线性超阈。
		const maxGrowth = Math.max(...perBatchGrowth)
		assertEquals(maxGrowth < 512 * 1024, true,
			`heap grew by ${maxGrowth} bytes between batches; a retained-per-send leak is suspected`)
	}
	finally {
		await shutdown?.()
	}
})
