import { test } from 'node:test'

import { createWebRtcLink } from '../../link/providers/webrtc.mjs'
import { loadNodeRtcPolyfill } from '../../link/rtc/index.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { identity } from '../helpers/identity.mjs'

/**
 * @returns {{ left: { send: (message: unknown) => void, onRemote: (handler: (message: unknown) => void) => void }, right: { send: (message: unknown) => void, onRemote: (handler: (message: unknown) => void) => void } }}
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
			 * @param {unknown} message
			 * @returns {void}
			 */
			send(message) {
				queueMicrotask(() => {
					if (rightHandler === null) rightQueue.push(message)
					else rightHandler(message)
				})
			},
			/**
			 * @param {(message: unknown) => void} handler
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
			 * @param {unknown} message
			 * @returns {void}
			 */
			send(message) {
				queueMicrotask(() => {
					if (leftHandler === null) leftQueue.push(message)
					else leftHandler(message)
				})
			},
			/**
			 * @param {(message: unknown) => void} handler
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
		const rtc = await loadNodeRtcPolyfill({
			backends: [{
				id: 'node-datachannel',
				/**
				 * @returns {Promise<never>}
				 */
				async load() {
					throw Object.assign(
						new Error("Cannot find module '../../../build/Release/node_datachannel.node'"),
						{ code: 'MODULE_NOT_FOUND' },
					)
				},
			}],
		})
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
