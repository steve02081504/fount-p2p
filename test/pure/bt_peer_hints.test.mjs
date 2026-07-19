import { test } from 'node:test'

import { createBluetoothDiscoveryProvider } from '../../discovery/bt/index.mjs'
import {
	BT_PEER_HINT_TTL_MS,
	clearBtPeerHints,
	getBtPeerHint,
	noteBtPeerHint,
} from '../../discovery/bt/peer_hints.mjs'
import {
	registerDiscoveryProvider,
	sendSignal,
} from '../../discovery/index.mjs'
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

test('bt sendSignal returns false without hint; fan-out still delivers via other provider', async () => {
	clearBtPeerHints()
	const nodeHash = 'ab'.repeat(32)
	const bt = createBluetoothDiscoveryProvider()
	assertEquals(await bt.sendSignal('topic', nodeHash, new Uint8Array([1])), false)

	let delivered = 0
	const fallback = {
		id: 'test-signal-fallback',
		priority: 0,
		caps: { canSignal: true },
		/**
		 *
		 */
		sendSignal() { delivered++ },
	}
	const stopBt = registerDiscoveryProvider(bt)
	const stopFallback = registerDiscoveryProvider(fallback)
	try {
		await sendSignal('topic', nodeHash, new Uint8Array([1]))
		assertEquals(delivered, 1)
	}
	finally {
		stopBt()
		stopFallback()
		clearBtPeerHints()
	}
})
