import { test } from 'node:test'

import { assertEquals } from '../../test/helpers/assert.mjs'
import { parseDurationMs, pastDeadline } from '../duration.mjs'

test('parseDurationMs', () => {
	assertEquals(parseDurationMs('5m'), 300_000)
	assertEquals(parseDurationMs('90s'), 90_000)
	assertEquals(parseDurationMs('500ms'), 500)
	assertEquals(parseDurationMs('2h'), 7_200_000)
	assertEquals(parseDurationMs('300'), 300_000)
	assertEquals(parseDurationMs(undefined), null)
	assertEquals(parseDurationMs('nope'), null)
})

test('pastDeadline', () => {
	assertEquals(pastDeadline(1000, 999), false)
	assertEquals(pastDeadline(1000, 1000), true)
	assertEquals(pastDeadline(null, 9999), false)
})
