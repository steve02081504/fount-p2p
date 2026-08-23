import { test } from 'node:test'

import { configureBufferedAmountLowThreshold, onBufferedAmountLow, readBufferedAmount } from '../../link/channel_mux.mjs'
import { createWebRtcLink } from '../../link/providers/webrtc.mjs'
import { waitForChannelState } from '../../link/rtc/index.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { identity } from '../helpers/identity.mjs'
import { loadPureJsBackend } from '../helpers/rtc_pure_js_backend.mjs'

/**
 * @returns {{ left: { send: (message: unknown) => void, onRemote: (handler: (message: unknown) => void) => void }, right: { send: (message: unknown) => void, onRemote: (handler: (message: unknown) => void) => void } }} 内存信令对
 */
function createSignalPair() {
	/** @type {((message: unknown) => void) | null} */
	let leftHandler = null
	/** @type {((message: unknown) => void) | null} */
	let rightHandler = null
	const leftQueue = []
	const rightQueue = []
	return {
		left: {
			/**
			 * @param {unknown} message 信令消息
			 * @returns {void}
			 */
			send(message) {
				queueMicrotask(() => {
					if (rightHandler === null) rightQueue.push(message)
					else rightHandler(message)
				})
			},
			/**
			 * @param {(message: unknown) => void} handler 远端消息回调
			 * @returns {void}
			 */
			onRemote(handler) {
				leftHandler = handler
				for (const message of leftQueue.splice(0))
					queueMicrotask(() => handler(message))
			},
		},
		right: {
			/**
			 * @param {unknown} message 信令消息
			 * @returns {void}
			 */
			send(message) {
				queueMicrotask(() => {
					if (leftHandler === null) leftQueue.push(message)
					else leftHandler(message)
				})
			},
			/**
			 * @param {(message: unknown) => void} handler 远端消息回调
			 * @returns {void}
			 */
			onRemote(handler) {
				rightHandler = handler
				for (const message of rightQueue.splice(0))
					queueMicrotask(() => handler(message))
			},
		},
	}
}

test({
	name: 'pure-js RTC backend can complete WebRTC link handshake',
	sanitizeOps: false,
	sanitizeResources: false,
	/**
	 * @returns {Promise<void>}
	 */
	async fn() {
		const rtc = await loadPureJsBackend()
		assertEquals(rtc.backend, 'node-rtc-connection')

		const alice = identity(41)
		const bob = identity(42)
		const signals = createSignalPair()
		const aliceLink = await createWebRtcLink({
			nodeHash: bob.nodeHash,
			initiator: true,
			signal: signals.left,
			iceServers: [],
			localIdentity: alice,
			rtc,
		})
		const bobLink = await createWebRtcLink({
			nodeHash: alice.nodeHash,
			initiator: false,
			signal: signals.right,
			iceServers: [],
			localIdentity: bob,
			rtc,
		})
		try {
			await Promise.all([aliceLink.ready, bobLink.ready])
			assertEquals(aliceLink.providerId, 'webrtc')
			assertEquals(bobLink.providerId, 'webrtc')
		}
		finally {
			await Promise.all([aliceLink.close(), bobLink.close()])
		}
	},
})

test({
	name: 'pure-js backend exposes real bufferedAmount growth + bufferedamountlow backpressure',
	sanitizeOps: false,
	sanitizeResources: false,
	/**
	 * 验证 node-rtc-connection 的 bufferedAmount/bufferedamountlow 可作背压信号（上游 #17）。
	 * @returns {Promise<void>}
	 */
	async fn() {
		const rtc = await loadPureJsBackend()
		const alice = identity(43)
		const bob = identity(44)
		const signals = createSignalPair()
		const aliceLink = await createWebRtcLink({
			nodeHash: bob.nodeHash,
			initiator: true,
			signal: signals.left,
			iceServers: [],
			localIdentity: alice,
			rtc,
		})
		const bobLink = await createWebRtcLink({
			nodeHash: alice.nodeHash,
			initiator: false,
			signal: signals.right,
			iceServers: [],
			localIdentity: bob,
			rtc,
		})
		try {
			await Promise.all([aliceLink.ready, bobLink.ready])
			const sender = aliceLink.channelForTest('bulk')
			if (!sender) throw new Error('bulk channel unavailable after link ready')
			await waitForChannelState(sender, 'open', 30_000)
			const threshold = 64 * 1024
			assertEquals(configureBufferedAmountLowThreshold(sender, threshold), threshold)
			let lowFired = false
			await new Promise((resolve, reject) => {
				const chunk = new Uint8Array(32 * 1024)
				/** @type {ReturnType<typeof setTimeout> | null} */
				let timer = null
				const stop = onBufferedAmountLow(sender, () => {
					lowFired = true
					stop()
					if (timer) clearTimeout(timer)
					resolve()
				})
				timer = setTimeout(() => { stop(); reject(new Error('bufferedamountlow timeout')) }, 30_000)
				let maxBuffered = 0
				let sends = 0
				while (maxBuffered <= threshold && sends < 256) {
					sender.send(chunk)
					maxBuffered = Math.max(maxBuffered, readBufferedAmount(sender))
					sends++
				}
				try {
					assertEquals(maxBuffered > threshold, true, `buffer never exceeded threshold: max=${maxBuffered}, threshold=${threshold}`)
				}
				catch (error) {
					stop()
					if (timer) clearTimeout(timer)
					throw error
				}
			})
			assertEquals(lowFired, true)
		}
		finally {
			await Promise.all([aliceLink.close(), bobLink.close()])
		}
	},
})
