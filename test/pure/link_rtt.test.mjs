import { test } from 'node:test'

import { createLinkPipe } from '../../link/pipe.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { identity } from '../helpers/identity.mjs'

const A = identity(1)
const B = identity(2)
const BINDING = 'ab'.repeat(32)

/**
 * 创建两个背靠背的 pipe，直接互传 control/frame。
 * @returns {{ pipeA: ReturnType<typeof createLinkPipe>, pipeB: ReturnType<typeof createLinkPipe> }} pipe 对
 */
function connectPipes() {
	const deliverToA = data => queueMicrotask(() => pipeA.handleInbound(data))
	const deliverToB = data => queueMicrotask(() => pipeB.handleInbound(data))
	/** @type {ReturnType<typeof createLinkPipe>} */
	let pipeA
	/** @type {ReturnType<typeof createLinkPipe>} */
	let pipeB
	/**
	 * @param {boolean} initiator 是否发起方
	 * @param {string} nodeHash 目标节点
	 * @param {object} localIdentity 本地身份
	 * @returns {object} pipe 选项
	 */
	const optionsFor = (initiator, nodeHash, localIdentity) => ({
		providerId: 'mock',
		level: 10,
		initiator,
		nodeHash,
		localIdentity,
		getLocalBinding: () => BINDING,
		getRemoteBinding: () => BINDING,
		/**
		 * @param {string} text control JSON
		 * @returns {void}
		 */
		sendControlText: text => (initiator ? deliverToB(text) : deliverToA(text)),
		/**
		 * @param {string} _action action
		 * @param {Uint8Array} frame 帧
		 * @returns {void}
		 */
		sendFrame: (_action, frame) => (initiator ? deliverToB(frame) : deliverToA(frame)),
		heartbeatMs: 15,
		idleTimeoutMs: 5000,
		handshakeTimeoutMs: 3000,
		rttWindowSize: 5,
	})
	pipeA = createLinkPipe(optionsFor(true, B.nodeHash, A))
	pipeB = createLinkPipe(optionsFor(false, A.nodeHash, B))
	return { pipeA, pipeB }
}

test({
	name: 'pipe heartbeat measures RTT and exposes sliding window stats',
	sanitizeOps: false,
	/**
	 * 完成握手后等几个心跳，断言 stats 里的 RTT 指标。
	 */
	async fn() {
		const { pipeA, pipeB } = connectPipes()
		try {
			await Promise.all([pipeA.startHandshake(), pipeB.startHandshake()])
			await Promise.all([pipeA.ready, pipeB.ready])
			await new Promise(resolve => setTimeout(resolve, 80))
			const stats = pipeA.stats()
			assertEquals(stats.pingCount > 0, true)
			assertEquals(stats.pongCount > 0, true)
			assertEquals(typeof stats.rttMs, 'number')
			assertEquals(stats.rttMs >= 0, true)
			assertEquals(typeof stats.avgRttMs, 'number')
			assertEquals(typeof stats.minRttMs, 'number')
			assertEquals(typeof stats.maxRttMs, 'number')
		}
		finally {
			await pipeA.close('test-done')
			await pipeB.close('test-done')
		}
	},
})

test({
	name: 'pipe onRtt fires after pong round-trip',
	sanitizeOps: false,
	/**
	 * 订阅 onRtt，断言收到最新样本。
	 */
	async fn() {
		const { pipeA, pipeB } = connectPipes()
		try {
			await Promise.all([pipeA.startHandshake(), pipeB.startHandshake()])
			await Promise.all([pipeA.ready, pipeB.ready])
			/** @type {number[]} */
			const samples = []
			const off = pipeA.onRtt(rttMs => { samples.push(rttMs) })
			await new Promise(resolve => setTimeout(resolve, 50))
			off()
			assertEquals(samples.length > 0, true)
			assertEquals(samples.every(sample => sample >= 0), true)
		}
		finally {
			await pipeA.close('test-done')
			await pipeB.close('test-done')
		}
	},
})