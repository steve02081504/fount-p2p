import { test } from 'node:test'

import {
	BT_PEER_HINT_TTL_MS,
	clearBtPeerHints,
	getBtPeerHint,
	noteBtPeerHint,
} from '../../discovery/bt/peer_hints.mjs'
import { createBleGattLinkProvider } from '../../link/providers/ble_gatt.mjs'
import { assertEquals } from '../helpers/assert.mjs'

test('bt peer hints store and expire by TTL', () => {
	clearBtPeerHints()
	const nodeHash = 'cd'.repeat(32)
	noteBtPeerHint(nodeHash, 'aa:bb:cc:dd:ee:ff')
	const t0 = Date.now()
	assertEquals(getBtPeerHint(nodeHash, t0)?.peripheralId, 'aa:bb:cc:dd:ee:ff')
	noteBtPeerHint('nope', '')
	assertEquals(getBtPeerHint('nope', t0), null)
	assertEquals(getBtPeerHint(nodeHash, t0 + BT_PEER_HINT_TTL_MS + 1), null)
	clearBtPeerHints()
	assertEquals(getBtPeerHint(nodeHash, t0), null)
})

test('ble_gatt canReach follows bt peer hint', () => {
	clearBtPeerHints()
	const nodeHash = 'ef'.repeat(32)
	const provider = createBleGattLinkProvider()
	assertEquals(provider.canReach({ nodeHash }), false)
	noteBtPeerHint(nodeHash, '11:22:33:44:55:66')
	assertEquals(provider.canReach({ nodeHash }), true)
	clearBtPeerHints()
	assertEquals(provider.canReach({ nodeHash }), false)
})
