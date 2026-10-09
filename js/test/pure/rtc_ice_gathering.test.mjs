import { test } from 'node:test'

import {
	collectIceGathering,
} from '../../link/providers/webrtc.mjs'
import { assert, assertEquals } from '../helpers/assert.mjs'

/**
 * 构造可控的 gathering 观测源。
 * @param {{ states?: string[], candidates?: number[] }} [options] 预置序列（最后一个值会被持续复用）
 * @returns {{ options: object, advance: () => void }} 观测源与推进函数
 */
function createGatheringProbe(options = {}) {
	const states = options.states?.length ? options.states : ['gathering']
	const candidateSteps = options.candidates?.length ? options.candidates : [0]
	let stateIndex = 0
	let candidateIndex = 0
	return {
		options: {
			/**
			 * 读取当前 gathering 状态；序列用完后一直复用最后一个值。
			 * @returns {string} 预置序列里的当前状态
			 */
			iceGatheringState: () => states[Math.min(stateIndex, states.length - 1)],
			/**
			 * 读取当前候选数；序列用完后一直复用最后一个值。
			 * @returns {number} 预置序列里的当前候选数
			 */
			candidateCount: () => candidateSteps[Math.min(candidateIndex, candidateSteps.length - 1)],
			handshakeTimeoutMs: 30_000,
		},
		/** 推进一步：依次推进候选数与状态。 */
		advance() {
			candidateIndex = Math.min(candidateIndex + 1, candidateSteps.length - 1)
			stateIndex = Math.min(stateIndex + 1, states.length - 1)
		},
	}
}

test('collectIceGathering returns complete as soon as the state is complete', async () => {
	const probe = createGatheringProbe({ states: ['complete'] })
	assertEquals(await collectIceGathering(probe.options), 'complete')
})

test('collectIceGathering treats a quiet candidate stream as gathered even when the state never turns complete', async () => {
	// 复现 fount-p2p#37 次要观察：polyfill 派发了候选，但 iceGatheringState 仍停在 'gathering'。
	const probe = createGatheringProbe({ candidates: [0, 1] })
	const startedAt = Date.now()
	const timer = setInterval(() => probe.advance(), 60)
	try {
		assertEquals(await collectIceGathering(probe.options), 'stable')
	}
	finally {
		clearInterval(timer)
	}
	assertEquals(Date.now() - startedAt < 5_000, true)
})

test('collectIceGathering gives up on a stalled gathering instead of hanging forever', async () => {
	const probe = createGatheringProbe()
	/** @type {number[]} */
	const stalls = []
	const startedAt = Date.now()
	const result = await collectIceGathering({
		...probe.options,
		/**
		 * 收下停滞回报，用例据此断言只报一次。
		 * @param {number} info 已无候选的毫秒数
		 * @returns {number} 入栈后的数组长度（调用方忽略）
		 */
		onStall: info => stalls.push(info),
	})
	assertEquals(result, 'stalled')
	assertEquals(stalls.length, 1)
	// 必须在 handshakeTimeoutMs 之前就放行，否则「所有 relay 都超时」时必然撞 10s 硬失败。
	assertEquals(Date.now() - startedAt < 10_000, true, 'stall fallback fired before the handshake timeout')
})

test('collectIceGathering stops as soon as gathering reports complete after candidates', async () => {
	const probe = createGatheringProbe({ states: ['gathering', 'complete'], candidates: [0, 2] })
	const timer = setInterval(() => probe.advance(), 60)
	try {
		assertEquals(await collectIceGathering(probe.options), 'complete')
	}
	finally {
		clearInterval(timer)
	}
})

test('collectIceGathering still fails when a timeout is shorter than the stall window', async () => {
	const probe = createGatheringProbe()
	await assert.rejects(
		collectIceGathering({ ...probe.options, handshakeTimeoutMs: 200 }),
		error => /ice gathering incomplete after 200ms/.test(String(error?.message ?? error)),
	)
})
