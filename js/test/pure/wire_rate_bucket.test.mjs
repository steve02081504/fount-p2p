import { test } from 'node:test'

import { consumeWireRateBucket } from '../../wire/rate_bucket.mjs'
import { assertEquals } from '../helpers/assert.mjs'



test('consumeWireRateBucket allows first consumption', () => {
	const key = `bucket-first-${crypto.randomUUID()}`
	assertEquals(consumeWireRateBucket(key, { maxCount: 5 }), true)
})

test('consumeWireRateBucket rejects when count budget exhausted', () => {
	const key = `bucket-count-${crypto.randomUUID()}`
	const limits = { maxCount: 2 }
	assertEquals(consumeWireRateBucket(key, limits), true)
	assertEquals(consumeWireRateBucket(key, limits), true)
	assertEquals(consumeWireRateBucket(key, limits), false)
})

test('consumeWireRateBucket refills tokens after window elapses', () => {
	const key = `bucket-refill-${crypto.randomUUID()}`
	const limits = { maxCount: 1 }
	let now = 5_000_000
	const originalNow = Date.now
	/** @returns {number} 模拟时间戳 */
	function mockDateNow() {
		return now
	}
	Date.now = mockDateNow
	try {
		assertEquals(consumeWireRateBucket(key, limits), true)
		assertEquals(consumeWireRateBucket(key, limits), false)
		now += 60_001
		assertEquals(consumeWireRateBucket(key, limits), true)
	}
	finally {
		Date.now = originalNow
	}
})

test('consumeWireRateBucket enforces byte budget when configured', () => {
	const key = `bucket-bytes-${crypto.randomUUID()}`
	const limits = { maxCount: 10, maxBytesPerWindow: 1000, byteCount: 600 }
	assertEquals(consumeWireRateBucket(key, limits), true)
	assertEquals(consumeWireRateBucket(key, limits), false)
})
