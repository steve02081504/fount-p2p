import { test } from 'node:test'

import {
	encodeEntityHash,
	isEntityHash128,
	parseEntityHash,
} from '../../core/entity_id_parse.mjs'
import { assertEquals } from '../helpers/assert.mjs'


const NODE = 'b'.repeat(64)
const SUBJECT = 'c'.repeat(64)
const ENTITY = NODE + SUBJECT

test('entity_id_parse roundtrip', () => {
	assertEquals(isEntityHash128(ENTITY), true)
	assertEquals(parseEntityHash(ENTITY), {
		entityHash: ENTITY,
		nodeHash: NODE,
		subjectHash: SUBJECT,
	})
	assertEquals(encodeEntityHash(NODE, SUBJECT), ENTITY)
})

test('entity_id_parse rejects malformed input', () => {
	assertEquals(isEntityHash128('short'), false)
	assertEquals(parseEntityHash(''), null)
})
