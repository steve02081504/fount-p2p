import { test } from 'node:test'

import {
	attachChannelMessageListener,
	attachDataChannelListener,
	attachIceCandidateListener,
	loadNodeRtcPolyfill,
	waitForChannelState,
} from '../../link/rtc.mjs'
import { assertEquals } from '../helpers/assert.mjs'

/**
 * 复现 Termux / 无 prebuild 平台：native addon MODULE_NOT_FOUND。
 * 修复前只能抛错或无 RTC；修复后应落到纯 JS 后端。
 */
test('loadNodeRtcPolyfill falls back when node-datachannel native is missing', async () => {
	const missingNative = Object.assign(
		new Error("Cannot find module '../../../build/Release/node_datachannel.node'"),
		{ code: 'MODULE_NOT_FOUND' },
	)
	const rtc = await loadNodeRtcPolyfill({
		backends: [
			{
				id: 'node-datachannel',
				/**
				 * @returns {Promise<never>}
				 */
				async load() {
					throw missingNative
				},
			},
		],
	})
	assertEquals(typeof rtc.RTCPeerConnection, 'function')
	assertEquals(typeof rtc.RTCIceCandidate, 'function')
	assertEquals(rtc.backend, 'node-rtc-connection')
})

test('EventEmitter-style RTC peers wire through attach helpers', async () => {
	const { EventEmitter } = await import('node:events')

	class FakeChannel extends EventEmitter {
		readyState = 'connecting'
		/**
		 * @returns {void}
		 */
		open() {
			this.readyState = 'open'
			this.emit('open')
		}
	}

	class FakePC extends EventEmitter {
		/** @type {((event: unknown) => void) | null} */
		#ice = null
		/** @type {((event: unknown) => void) | null} */
		#dc = null
		/**
		 * @param {string} label
		 * @returns {FakeChannel}
		 */
		createDataChannel(label) {
			const ch = new FakeChannel()
			ch.label = label
			return ch
		}
		/** @returns {((event: unknown) => void) | null} */
		get onicecandidate() { return this.#ice }
		/** @param {((event: unknown) => void) | null} handler */
		set onicecandidate(handler) { this.#ice = handler }
		/** @returns {((event: unknown) => void) | null} */
		get ondatachannel() { return this.#dc }
		/** @param {((event: unknown) => void) | null} handler */
		set ondatachannel(handler) { this.#dc = handler }
		/**
		 * @param {string} event
		 * @param {unknown} payload
		 * @returns {boolean}
		 */
		emit(event, payload) {
			if (event === 'icecandidate') this.#ice?.(payload)
			if (event === 'datachannel') this.#dc?.(payload)
			return super.emit(event, payload)
		}
	}

	const pc = new FakePC()
	/** @type {{ candidate: unknown } | null} */
	let ice = null
	/** @type {{ channel: FakeChannel } | null} */
	let dc = null
	attachIceCandidateListener(pc, event => {
		ice = event
	})
	attachDataChannelListener(pc, event => {
		dc = event
	})

	const channel = pc.createDataChannel('control')
	/** @type {unknown} */
	let message = null
	attachChannelMessageListener(channel, data => {
		message = data
	})
	const opened = waitForChannelState(/** @type {any} */ (channel), 'open', 1000)

	pc.emit('icecandidate', { candidate: { candidate: 'x' } })
	pc.emit('datachannel', { channel })
	channel.open()
	channel.emit('message', { data: 'ping' })

	await opened
	assertEquals(!!ice?.candidate, true)
	assertEquals(dc?.channel, channel)
	assertEquals(message, 'ping')
})
