import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { waitPoweredOn } from '../../discovery/bt/index.mjs'
import { assertEquals } from '../helpers/assert.mjs'

test('waitPoweredOn prefers waitForPoweredOnAsync', async () => {
	let called = ''
	const runtime = {
		/**
		 * 等待 BT powered-on 的同步 API
		 */
		waitForPoweredOn() {
			called = 'sync'
		},
		/**
		 * 等待 BT powered-on 的异步 API
		 * @param {number} timeout 等待 BT powered-on 的超时（毫秒）
		 * @returns {Promise<void>}
		 */
		async waitForPoweredOnAsync(timeout) {
			called = `async:${timeout}`
		},
	}
	await waitPoweredOn(runtime, 5_000)
	assertEquals(called, 'async:5000')
})

test('waitPoweredOn falls back to waitForPoweredOn', async () => {
	let called = ''
	const runtime = {
		/**
		 * 等待 BT powered-on 的同步 API
		 * @param {number} timeout 等待 BT powered-on 的超时（毫秒）
		 * @returns {Promise<void>}
		 */
		waitForPoweredOn(timeout) {
			called = `sync:${timeout}`
			return Promise.resolve()
		},
	}
	await waitPoweredOn(runtime, 3_000)
	assertEquals(called, 'sync:3000')
})

test('waitPoweredOn throws when no powered-on API', async () => {
	await assert.rejects(
		() => waitPoweredOn({}),
		/p2p: bluetooth runtime missing waitForPoweredOn\(Async\)/,
	)
})
