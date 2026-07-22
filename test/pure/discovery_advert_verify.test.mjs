import { test } from 'node:test'

import {
	buildSignedAdvertForScope,
	encryptAdvertForScope,
} from '../../discovery/adverts.mjs'
import {
	encryptSignalPacket,
	groupRendezvousKey,
	networkRendezvousKey,
} from '../../discovery/internal/signal_crypto.mjs'
import {
	acceptNostrAdvert,
	clearNostrVisibleNodes,
	listNostrGroupVisibleNodeHashes,
	listNostrVisibleNodeHashes,
} from '../../discovery/nostr.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { identity } from '../helpers/identity.mjs'

test('acceptNostrAdvert verifies network advert before visible pool', async () => {
	clearNostrVisibleNodes()
	const local = identity(11)
	const body = await buildSignedAdvertForScope('network', local)
	const bytes = encryptAdvertForScope('network', local, body)
	assertEquals(await acceptNostrAdvert(networkRendezvousKey(), bytes), local.nodeHash)
	assertEquals(listNostrVisibleNodeHashes().includes(local.nodeHash), true)
	clearNostrVisibleNodes()
})

test('acceptNostrAdvert rejects forged network advert', async () => {
	clearNostrVisibleNodes()
	const fakeHash = 'ef'.repeat(32)
	const bytes = encryptSignalPacket(networkRendezvousKey(), {
		type: 'advert',
		body: {
			nodeHash: fakeHash,
			nodePubKey: 'ab'.repeat(32),
			ts: Date.now(),
			sig: '11'.repeat(64),
		},
	})
	assertEquals(await acceptNostrAdvert(networkRendezvousKey(), bytes), null)
	assertEquals(listNostrVisibleNodeHashes().includes(fakeHash), false)
	clearNostrVisibleNodes()
})

test('acceptNostrAdvert verifies group advert into group pool only', async () => {
	clearNostrVisibleNodes()
	const local = identity(13)
	const roomSecret = 'room-verify-1'
	const body = await buildSignedAdvertForScope({ roomSecret }, local)
	const bytes = encryptAdvertForScope({ roomSecret }, local, body)
	assertEquals(
		await acceptNostrAdvert(groupRendezvousKey(roomSecret), bytes, { roomSecret }),
		local.nodeHash,
	)
	assertEquals(listNostrGroupVisibleNodeHashes(roomSecret), [local.nodeHash])
	assertEquals(listNostrVisibleNodeHashes().includes(local.nodeHash), false)
	clearNostrVisibleNodes()
})
