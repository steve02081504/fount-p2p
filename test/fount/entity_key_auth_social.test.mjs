import { strict as assert } from 'node:assert'
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'

import { keyPairFromSeed } from '../../crypto/crypto.mjs'
import { activeSenderHashFromPubKeyHex } from '../../federation/entity_key_chain.mjs'
import { fountBridgeSkipReason, importSocialModule } from '../helpers/fount_paths.mjs'

const skip = await fountBridgeSkipReason('federation/entity_key_auth.mjs')
const entityKeyAuth = skip ? null : await importSocialModule('federation/entity_key_auth.mjs')

test('social foldEntityKeyHistoryFromEvents tracks social_meta and rotate', { skip }, () => {
	const recovery = keyPairFromSeed(randomBytes(32))
	const active = keyPairFromSeed(randomBytes(32))
	const recoveryHex = Buffer.from(recovery.publicKey).toString('hex')
	const activeHex = Buffer.from(active.publicKey).toString('hex')
	const events = [
		{ type: 'social_meta', content: { recoveryPubKeyHex: recoveryHex } },
		{ type: 'entity_key_rotate', content: { generation: 0, activePubKeyHex: activeHex }, hlc: { wall: 1 }, timestamp: 1 },
	]
	const folded = entityKeyAuth.foldEntityKeyHistoryFromEvents(events)
	assert.equal(folded.recoveryPubKeyHex, recoveryHex)
	assert.equal(folded.entityKeyHistory.length, 1)
	assert.equal(entityKeyAuth.isEntityTimelineWriteAuthorized({
		entityHash: 'a'.repeat(128),
		sender: activeSenderHashFromPubKeyHex(activeHex),
		eventType: 'post',
		eventContent: {},
		recoveryPubKeyHex: recoveryHex,
		entityKeyHistory: folded.entityKeyHistory,
	}), true)
})
