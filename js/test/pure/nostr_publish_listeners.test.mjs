import { test } from 'node:test'

import { WebSocket } from 'ws'

import { publishViaSharedRelay, subscribeNostrKind } from '../../discovery/nostr/session.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { startFakeRelay } from '../helpers/fake_relay.mjs'

test('late concurrent shared publishes stay within the socket listener limit and release listeners after OK and abort', async () => {
	const relay = await startFakeRelay(() => true, { okDelayMs: 100 })
	const url = `ws://127.0.0.1:${relay.port}`
	const originalOn = WebSocket.prototype.on
	let socket
	let exceeded = false
	/**
	 * 包一层 `WebSocket.prototype.on`，记录实时 socket 并检查 message 监听器有没有超限。
	 * @param {string} name 事件名
	 * @param {(...args: unknown[]) => void} listener 事件监听器
	 * @returns {WebSocket} 原 `on` 的返回值（ws 返回 this，便于链式调用）
	 */
	WebSocket.prototype.on = function (name, listener) {
		const result = originalOn.call(this, name, listener)
		if (name === 'message' && this.url && new URL(this.url).port === String(relay.port)) {
			socket = this
			exceeded ||= this.listenerCount(name) > this.getMaxListeners()
		}
		return result
	}
	const stop = subscribeNostrKind([url], { kind: 20787, rendezvousKey: 'test', tagX: 'signal',
		/**
		 * 载荷不参与断言，订阅只是为了让共享 session 真的挂上监听器。
		 * @returns {void}
		 */
		onPayload() {} })
	try {
		await relay.waitReqs(1)
		const baseline = socket.listenerCount('message')
		const abort = new AbortController()
		const attempts = Array.from({ length: 40 }, (_, index) =>
			publishViaSharedRelay(url, { id: `burst-${index}` }, index % 2 ? abort.signal : undefined))
		const result = Promise.allSettled(attempts)
		abort.abort()
		const outcomes = await result
		assertEquals(outcomes.filter(row => row.status === 'fulfilled' && row.value === true).length, 20)
		assertEquals(outcomes.filter(row => row.status === 'rejected').length, 20)
		assertEquals(socket.listenerCount('message'), baseline)
		assertEquals(exceeded, false, 'a late burst must never exceed the live socket limit')
	}
	finally {
		WebSocket.prototype.on = originalOn
		stop()
		await relay.stop()
	}
})
