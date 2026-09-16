import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
	getRecentStalePeerPrunes,
	getStalePeerPruneCount,
	recordStalePeerPrune,
} from '../../transport/stale_peer_log.mjs'

test('recordStalePeerPrune accumulates per scope and retains recent entries', () => {
	const scope = `test-scope-${Date.now()}`
	recordStalePeerPrune(scope, [
		{ peerId: 'p1', remoteNodeHash: 'a'.repeat(64) },
		{ peerId: 'p2', remoteNodeHash: 'b'.repeat(64) },
	])
	assert.equal(getStalePeerPruneCount(scope), 2)
	const recent = getRecentStalePeerPrunes()
	assert.equal(recent.some(row => row.scope === scope && row.peerId === 'p1'), true)
})

test('recordStalePeerPrune ignores empty batches', () => {
	const scope = `empty-scope-${Date.now()}`
	recordStalePeerPrune(scope, [])
	assert.equal(getStalePeerPruneCount(scope), 0)
})
