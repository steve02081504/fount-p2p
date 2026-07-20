import { test } from 'node:test'

import {
	SIGNAL_KEY_CACHE_MAX,
	decryptSignalPacket,
	encryptSignalPacket,
	signalKeyCacheSize,
} from '../../transport/signal_crypto.mjs'
import { assertEquals } from '../helpers/assert.mjs'

test('signal key cache is bounded by topic churn', () => {
	const before = signalKeyCacheSize()
	for (let i = 0; i < SIGNAL_KEY_CACHE_MAX + 80; i++) {
		const topic = `topic-churn-${i}-${Math.random().toString(16).slice(2)}`
		const bytes = encryptSignalPacket(topic, { i })
		assertEquals(decryptSignalPacket(topic, bytes)?.i, i)
	}
	assertEquals(signalKeyCacheSize() <= SIGNAL_KEY_CACHE_MAX, true)
	assertEquals(signalKeyCacheSize() >= Math.min(SIGNAL_KEY_CACHE_MAX, before), true)
})
