import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'

import { hashFromPubKeyHex } from '../../core/entity_id.mjs'
import { keyPairFromSeed } from '../../crypto/crypto.mjs'
import {
	createGenesisKeyHistory,
	foldEntityKeyHistoryFromEvents,
	isRecoverySender,
	isValidActiveSender,
} from '../../federation/entity_key_chain.mjs'
import { assertEquals } from '../helpers/assert.mjs'

test('recovery subject anchors entity identity', () => {
	const recovery = keyPairFromSeed(randomBytes(32))
	const active = keyPairFromSeed(randomBytes(32))
	const recoveryHex = Buffer.from(recovery.publicKey).toString('hex')
	const activeHex = Buffer.from(active.publicKey).toString('hex')
	const subject = hashFromPubKeyHex(recoveryHex)
	assertEquals(subject, hashFromPubKeyHex(recoveryHex))
	assertEquals(isRecoverySender(recoveryHex, subject), true)
	assertEquals(isValidActiveSender(createGenesisKeyHistory(activeHex), hashFromPubKeyHex(activeHex)), true)
})

test('foldEntityKeyHistoryFromEvents tracks rotate', () => {
	const active = keyPairFromSeed(randomBytes(32))
	const activeHex = Buffer.from(active.publicKey).toString('hex')
	const events = [
		{ type: 'entity_key_rotate', content: { generation: 0, activePubKeyHex: activeHex }, hlc: { wall: 1 }, timestamp: 1 },
	]
	const folded = foldEntityKeyHistoryFromEvents(events)
	assertEquals(folded.recoveryPubKeyHex, null)
	assertEquals(folded.entityKeyHistory.length, 1)
})
