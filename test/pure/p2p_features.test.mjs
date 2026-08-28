import { test } from 'node:test'

import {
	defaultP2PFeatures,
	resolveP2PFeatures,
} from '../../node/feature_config.mjs'
import { assertEquals, assertThrows } from '../helpers/assert.mjs'

test('default features: census on by default', () => {
	assertEquals(defaultP2PFeatures(), { census: true })
})

test('resolveP2PFeatures keeps unknown boolean flags through', () => {
	assertEquals(resolveP2PFeatures({ foo: true, bar: false }), { census: true, foo: true, bar: false })
})

test('resolveP2PFeatures overrides known default', () => {
	assertEquals(resolveP2PFeatures({ census: false }), { census: false })
})

test('resolveP2PFeatures returns full snapshot copy', () => {
	const resolved = resolveP2PFeatures({ census: true })
	assertEquals(resolved, { census: true })
	assertEquals(Object.isFrozen(resolved), false)
})

test('resolveP2PFeatures rejects non-boolean values', () => {
	assertThrows(() => resolveP2PFeatures({ census: 'yes' }), /must be boolean/)
	assertThrows(() => resolveP2PFeatures({ census: 1 }), /must be boolean/)
	assertThrows(() => resolveP2PFeatures({ census: null }), /must be boolean/)
})

test('resolveP2PFeatures tolerates undefined patch', () => {
	assertEquals(resolveP2PFeatures(), { census: true })
})
