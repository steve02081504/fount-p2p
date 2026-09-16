import { test } from 'node:test'

import { createTtlMap } from '../../utils/ttl_map.mjs'
import { assertEquals } from '../helpers/assert.mjs'

test('ttl map evicts when over maxSize even without get', () => {
	const map = createTtlMap(60_000, 8)
	for (let i = 0; i < 20; i++)
		map.set(`k${i}`, i)
	assertEquals(map.size() <= 8, true)
	assertEquals(map.get('k19'), 19)
	assertEquals(map.get('k0'), null)
})

test('ttl map expires on get', () => {
	const map = createTtlMap(1000, 64)
	map.set('a', 1)
	const t0 = Date.now()
	assertEquals(map.get('a', t0), 1)
	assertEquals(map.get('a', t0 + 1001), null)
	assertEquals(map.size(), 0)
})
