import { test } from 'node:test'

import { hasDanglingParents } from '../../governance/branch.mjs'
import { assertEquals } from '../helpers/assert.mjs'

/**
 * DAG 悬挂父检测单元测试。
 */


const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)

test('hasDanglingParents: empty events', () => {
	assertEquals(hasDanglingParents([]), false)
})

test('hasDanglingParents: root event without parents', () => {
	assertEquals(hasDanglingParents([{ id: A, prev_event_ids: [] }]), false)
})

test('hasDanglingParents: complete chain', () => {
	assertEquals(hasDanglingParents([
		{ id: A, prev_event_ids: [] },
		{ id: B, prev_event_ids: [A] },
	]), false)
})

test('hasDanglingParents: missing parent reference', () => {
	assertEquals(hasDanglingParents([
		{ id: B, prev_event_ids: [A] },
	]), true)
})

test('hasDanglingParents: tip with dangling ancestor gap', () => {
	assertEquals(hasDanglingParents([
		{ id: A, prev_event_ids: [] },
		{ id: C, prev_event_ids: [B] },
	]), true)
})
