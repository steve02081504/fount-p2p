import { test } from 'node:test'

import { createLinkPipe } from '../../link/pipe.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { identity } from '../helpers/identity.mjs'

const initiatorIdentity = identity(1)
const responderIdentity = identity(2)
const BINDING = 'ab'.repeat(32)

/**
 * 创建两个背靠背的 pipe，直接互传 control/frame。
 * @returns {{ initiatorPipe: ReturnType<typeof createLinkPipe>, responderPipe: ReturnType<typeof createLinkPipe> }} pipe 对
 */
function connectPipes() {
	const deliverToInitiator = data => queueMicrotask(() => initiatorPipe.handleInbound(data))
	const deliverToResponder = data => queueMicrotask(() => responderPipe.handleInbound(data))
	/** @type {ReturnType<typeof createLinkPipe>} */
	let initiatorPipe
	/** @type {ReturnType<typeof createLinkPipe>} */
	let responderPipe
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
		sendControlText: text => (initiator ? deliverToResponder(text) : deliverToInitiator(text)),
		/**
		 * @param {string} action action
		 * @param {Uint8Array} frame 帧
		 * @returns {void}
		 */
		sendFrame: (action, frame) => (initiator ? deliverToResponder(frame) : deliverToInitiator(frame)),
		heartbeatMs: 15,
		idleTimeoutMs: 5000,
		handshakeTimeoutMs: 3000,
		rttWindowSize: 5,
	})
	initiatorPipe = createLinkPipe(optionsFor(true, responderIdentity.nodeHash, initiatorIdentity))
	responderPipe = createLinkPipe(optionsFor(false, initiatorIdentity.nodeHash, responderIdentity))
	return { initiatorPipe, responderPipe }
}

/**
 * 创建背靠背 pipe，但把发起方发出的每个 ping 延迟 DELAY 后才送达对端。
 * 这样 pong 回到发起方时，发起方通常已发出后续心跳。
 * @param {number} delayMs 发起方 ping 的送达延迟
 * @returns {{ initiatorPipe: ReturnType<typeof createLinkPipe>, responderPipe: ReturnType<typeof createLinkPipe> }} pipe 对
 */
function connectPipesDelayedPong(delayMs) {
	const deliverToInitiator = data => queueMicrotask(() => initiatorPipe.handleInbound(data))
	const deliverToResponder = data => queueMicrotask(() => responderPipe.handleInbound(data))
	/** @type {ReturnType<typeof createLinkPipe>} */
	let initiatorPipe
	/** @type {ReturnType<typeof createLinkPipe>} */
	let responderPipe
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
		sendControlText: text => (initiator ? deliverToResponder(text) : deliverToInitiator(text)),
		sendFrame: (action, frame) => {
			if (initiator && action === 'ping') setTimeout(() => deliverToResponder(frame), delayMs)
			else if (initiator) deliverToResponder(frame)
			else deliverToInitiator(frame)
		},
		heartbeatMs: 15,
		idleTimeoutMs: 5000,
		handshakeTimeoutMs: 3000,
		rttWindowSize: 5,
	})
	initiatorPipe = createLinkPipe(optionsFor(true, responderIdentity.nodeHash, initiatorIdentity))
	responderPipe = createLinkPipe(optionsFor(false, initiatorIdentity.nodeHash, responderIdentity))
	return { initiatorPipe, responderPipe }
}

test({
	name: 'pipe heartbeat measures RTT and exposes sliding window stats',
	sanitizeOps: false,
	/**
	 * 完成握手后等几个心跳，断言 stats 里的 RTT 指标。
	 */
	async fn() {
		const { initiatorPipe, responderPipe } = connectPipes()
		try {
			await Promise.all([initiatorPipe.startHandshake(), responderPipe.startHandshake()])
			await Promise.all([initiatorPipe.ready, responderPipe.ready])
			await new Promise(resolve => setTimeout(resolve, 80))
			const stats = initiatorPipe.stats()
			assertEquals(stats.pingCount > 0, true)
			assertEquals(stats.pongCount > 0, true)
			assertEquals(typeof stats.rttMs, 'number')
			assertEquals(stats.rttMs >= 0, true)
			assertEquals(typeof stats.avgRttMs, 'number')
			assertEquals(typeof stats.minRttMs, 'number')
			assertEquals(typeof stats.maxRttMs, 'number')
		}
		finally {
			await initiatorPipe.close('test-done')
			await responderPipe.close('test-done')
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
		const { initiatorPipe, responderPipe } = connectPipes()
		try {
			await Promise.all([initiatorPipe.startHandshake(), responderPipe.startHandshake()])
			await Promise.all([initiatorPipe.ready, responderPipe.ready])
			/** @type {number[]} */
			const samples = []
			const unsubscribe = initiatorPipe.onRtt(rttMs => { samples.push(rttMs) })
			await new Promise(resolve => setTimeout(resolve, 50))
			unsubscribe()
			assertEquals(samples.length > 0, true)
			assertEquals(samples.every(sample => sample >= 0), true)
		}
		finally {
			await initiatorPipe.close('test-done')
			await responderPipe.close('test-done')
		}
	},
})

test({
	name: 'pipe RTT matches the ping it answers even after a later heartbeat',
	sanitizeOps: false,
	/**
	 * 发起方 ping 被延迟，pong 回到发起方时已越过后续心跳。
	 * 发起方仍应仅按 sent-ping 记录（seq+ts）匹配并算出 RTT。
	 */
	async fn() {
		const { initiatorPipe, responderPipe } = connectPipesDelayedPong(40)
		try {
			await Promise.all([initiatorPipe.startHandshake(), responderPipe.startHandshake()])
			await Promise.all([initiatorPipe.ready, responderPipe.ready])
			await new Promise(resolve => setTimeout(resolve, 70))
			const stats = initiatorPipe.stats()
			assertEquals(stats.pingCount > 0, true)
			assertEquals(stats.pongCount > 0, true)
			assertEquals(typeof stats.rttMs, 'number')
			assertEquals(stats.rttMs >= 0, true)
		}
		finally {
			await initiatorPipe.close('test-done')
			await responderPipe.close('test-done')
		}
	},
})