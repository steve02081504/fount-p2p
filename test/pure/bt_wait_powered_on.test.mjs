import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { waitPoweredOn } from '../../discovery/bt.mjs'
import { assertEquals } from '../helpers/assert.mjs'

test('waitPoweredOn prefers waitForPoweredOnAsync', async () => {
	let called = ''
	const runtime = {
		waitForPoweredOn() {
			called = 'sync'
		},
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
