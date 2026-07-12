import { strict as assert } from 'node:assert'
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'

import { keyPairFromSeed } from '../../crypto/crypto.mjs'
import { activeSenderHashFromPubKeyHex } from '../../federation/operator_key_chain.mjs'
import { fountSkipReason, importSocialModule } from '../helpers/fount_paths.mjs'

const skip = await fountSkipReason()
const operatorKeyAuth = skip ? null : await importSocialModule('federation/operator_key_auth.mjs')

test('social foldOperatorKeyHistoryFromEvents tracks social_meta and rotate', { skip }, () => {
	const recovery = keyPairFromSeed(randomBytes(32))
	const active = keyPairFromSeed(randomBytes(32))
	const recoveryHex = Buffer.from(recovery.publicKey).toString('hex')
	const activeHex = Buffer.from(active.publicKey).toString('hex')
	const events = [
		{ type: 'social_meta', content: { recoveryPubKeyHex: recoveryHex } },
		{ type: 'operator_key_rotate', content: { generation: 0, activePubKeyHex: activeHex }, hlc: { wall: 1 }, timestamp: 1 },
	]
	const folded = operatorKeyAuth.foldOperatorKeyHistoryFromEvents(events)
	assert.equal(folded.recoveryPubKeyHex, recoveryHex)
	assert.equal(folded.operatorKeyHistory.length, 1)
	assert.equal(operatorKeyAuth.isOperatorTimelineWriteAuthorized({
		entityHash: 'a'.repeat(128),
		sender: activeSenderHashFromPubKeyHex(activeHex),
		eventType: 'post',
		eventContent: {},
		recoveryPubKeyHex: recoveryHex,
		operatorKeyHistory: folded.operatorKeyHistory,
	}), true)
})
