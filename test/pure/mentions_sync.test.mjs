import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
	encodeEntityHash,
	isEntityHash128,
	parseEntityHash,
} from '../../core/entity_id_parse.mjs'
import { fountSkipReason, importPagesP2pModule } from '../helpers/fount_paths.mjs'

const skip = await fountSkipReason()
const pages = skip ? null : await importPagesP2pModule('entity_id_parse.mjs')
const mentions = skip ? null : await importPagesP2pModule('mentions.mjs')

const NODE = 'b'.repeat(64)
const SUBJECT = 'c'.repeat(64)
const ENTITY = NODE + SUBJECT

test('entity_id_parse package mirrors pages implementation', { skip }, () => {
	assert.equal(isEntityHash128(ENTITY), pages.isEntityHash128(ENTITY))
	assert.deepEqual(parseEntityHash(ENTITY), pages.parseEntityHash(ENTITY))
	assert.equal(encodeEntityHash(NODE, SUBJECT), pages.encodeEntityHash(NODE, SUBJECT))
})

test('pages mentions extract @entityHash', { skip }, () => {
	const text = `hello @${ENTITY} world`
	assert.deepEqual(mentions.extractMentionEntityHashes(text), [ENTITY])
})
