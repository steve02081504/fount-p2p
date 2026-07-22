import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { cachePublicManifest, fetchPublicManifest } from '../../files/manifest_fetch.mjs'
import { buildUnverifiedSlashAlert } from '../../node/reputation_store.mjs'

test('buildUnverifiedSlashAlert builds volatile slash alert', () => {
	const sender = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
	const target = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
	const alert = buildUnverifiedSlashAlert(sender, { targetPubKeyHash: target, claim: 0.2 })
	assert.equal(alert.type, 'reputation_slash_alert')
	assert.equal(alert.targetPubKeyHash, target)
	assert.equal(alert.sender, sender)
})

test('fetchPublicManifest and cachePublicManifest are separate exports', () => {
	assert.equal(typeof fetchPublicManifest, 'function')
	assert.equal(typeof cachePublicManifest, 'function')
})
