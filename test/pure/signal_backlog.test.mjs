import { test } from 'node:test'

import { createBufferedSignalSession } from '../../transport/offer_answer.mjs'
import { assertEquals } from '../helpers/assert.mjs'

test('buffered signal session caps backlog without handlers', () => {
	const session = createBufferedSignalSession(async () => { })
	for (let i = 0; i < 200; i++)
		session.deliver({ i })
	/** @type {unknown[]} */
	const received = []
	session.onRemote(message => received.push(message))
	assertEquals(received.length, 64)
	assertEquals(received[0], { i: 136 })
	assertEquals(received[63], { i: 199 })
})
