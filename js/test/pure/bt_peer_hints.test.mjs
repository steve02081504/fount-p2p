import { test } from 'node:test'

import {
	buildSignedAdvertForScope,
	encryptAdvertForScope,
} from '../../discovery/adverts.mjs'
import {
	acceptBtScannedPresence,
	clearBtVisibleNodes,
	createBluetoothDiscoveryProvider,
	listBtVisibleNodeHashes,
} from '../../discovery/bt/index.mjs'
import {
	BT_PEER_HINT_TTL_MS,
	clearBtPeerHints,
	getBtPeerHint,
	noteBtPeerHint,
} from '../../discovery/bt/peer_hints.mjs'
import { encryptSignalPacket, networkRendezvousKey } from '../../discovery/internal/signal_crypto.mjs'
import { createBleGattLinkProvider } from '../../link/providers/ble_gatt.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { identity } from '../helpers/identity.mjs'

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

test('bt connectToNode returns false without peer hint', async () => {
	clearBtPeerHints()
	const nodeHash = 'ab'.repeat(32)
	const bt = createBluetoothDiscoveryProvider()
	assertEquals(await bt.connectToNode(nodeHash), false)
})

test('acceptBtScannedPresence verifies advert and records peripheral hint', async () => {
	clearBtPeerHints()
	clearBtVisibleNodes()
	const local = identity(7)
	const body = await buildSignedAdvertForScope('network', local)
	const bytes = encryptAdvertForScope('network', local, body)
	const peripheralId = 'scan-peripheral-01'
	const ingested = await acceptBtScannedPresence(bytes, { peripheralId })
	assertEquals(ingested?.verifiedNodeHash, local.nodeHash)
	assertEquals(getBtPeerHint(local.nodeHash)?.peripheralId, peripheralId)
	assertEquals(listBtVisibleNodeHashes().includes(local.nodeHash), true)
	clearBtPeerHints()
	clearBtVisibleNodes()
})

test('acceptBtScannedPresence rejects forged nodeHash without valid signature', async () => {
	clearBtPeerHints()
	clearBtVisibleNodes()
	const fakeHash = 'cd'.repeat(32)
	const bytes = encryptSignalPacket(networkRendezvousKey(), {
		type: 'advert',
		body: {
			nodeHash: fakeHash,
			nodePubKey: 'ab'.repeat(32),
			ts: Date.now(),
			sig: '00'.repeat(64),
		},
	})
	assertEquals(await acceptBtScannedPresence(bytes, { peripheralId: 'x' }), null)
	assertEquals(getBtPeerHint(fakeHash), null)
	assertEquals(listBtVisibleNodeHashes().includes(fakeHash), false)
	clearBtPeerHints()
	clearBtVisibleNodes()
})
