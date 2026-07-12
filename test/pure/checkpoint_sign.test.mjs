

import { Buffer } from 'node:buffer'
import { test } from 'node:test'


import {
	isSignedCheckpoint,
	signCheckpoint,
	verifyCheckpointSignature,
} from '../../crypto/checkpoint_sign.mjs'
import { keyPairFromSeed } from '../../crypto/crypto.mjs'
import { assertEquals } from '../helpers/assert.mjs'

test('signCheckpoint roundtrip verifies', async () => {
	const { publicKey, secretKey } = keyPairFromSeed(Buffer.alloc(32, 3))
	const payload = {
		eventIdsInEpoch: ['a'.repeat(64)],
		epoch_root_hash: 'b'.repeat(64),
		epoch_id: 1,
	}
	const signed = await signCheckpoint(payload, secretKey)
	assertEquals(isSignedCheckpoint(signed), true)
	assertEquals(await verifyCheckpointSignature(signed, publicKey), true)
})

test('verifyCheckpointSignature rejects tampered signature', async () => {
	const { publicKey, secretKey } = keyPairFromSeed(Buffer.alloc(32, 5))
	const signed = await signCheckpoint({ epoch_id: 2 }, secretKey)
	const bad = { ...signed, checkpoint_signature: 'c'.repeat(128) }
	assertEquals(await verifyCheckpointSignature(bad, publicKey), false)
})

test('isSignedCheckpoint rejects missing signature', () => {
	assertEquals(isSignedCheckpoint({ epoch_id: 1 }), false)
	assertEquals(isSignedCheckpoint(null), false)
})
