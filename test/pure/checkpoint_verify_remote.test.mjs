import { Buffer } from 'node:buffer'
import { test } from 'node:test'

import { signCheckpoint, verifyRemoteCheckpoint } from '../../crypto/checkpoint_sign.mjs'
import { keyPairFromSeed, pubKeyHash } from '../../crypto/crypto.mjs'
import { merkleRoot } from '../../dag/index.mjs'
import { assertEquals } from '../helpers/assert.mjs'

test('verifyRemoteCheckpoint rejects missing checkpoint', async () => {
	const result = await verifyRemoteCheckpoint(null)
	assertEquals(result.valid, false)
	assertEquals(result.reason, 'checkpoint missing or not an object')
})

test('verifyRemoteCheckpoint rejects empty eventIdsInEpoch', async () => {
	const result = await verifyRemoteCheckpoint({
		eventIdsInEpoch: [],
		epoch_root_hash: 'a'.repeat(64),
		checkpoint_signature: 'b'.repeat(128),
		epoch_id: 1,
	})
	assertEquals(result.valid, false)
	assertEquals(result.reason, 'eventIdsInEpoch missing or empty')
})

test('verifyRemoteCheckpoint rejects merkle mismatch', async () => {
	const result = await verifyRemoteCheckpoint({
		eventIdsInEpoch: ['a'.repeat(64)],
		epoch_root_hash: 'b'.repeat(64),
		checkpoint_signature: 'c'.repeat(128),
		epoch_id: 1,
		members_record: { members: {}, roles: {} },
	})
	assertEquals(result.valid, false)
	assertEquals(result.reason, 'epoch_root_hash does not match Merkle root of eventIdsInEpoch')
})

test('verifyRemoteCheckpoint accepts valid signed checkpoint', async () => {
	const { publicKey, secretKey } = keyPairFromSeed(Buffer.alloc(32, 11))
	const founderHash = pubKeyHash(publicKey)
	const pubHex = Buffer.from(publicKey).toString('hex')
	const eventId = 'a'.repeat(64)
	const epochRoot = merkleRoot([eventId])
	const payload = {
		eventIdsInEpoch: [eventId],
		epoch_root_hash: epochRoot,
		epoch_id: 1,
		members_record: {
			delegatedOwnerPubKeyHash: founderHash,
			members: {
				[founderHash]: { pubKeyHex: pubHex, status: 'active' },
			},
			roles: {},
		},
	}
	const signed = await signCheckpoint(payload, secretKey)
	const result = await verifyRemoteCheckpoint(signed)
	assertEquals(result.valid, true)
})
