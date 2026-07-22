import { test } from 'node:test'

import {
	clearDiscoveryProviders,
	listVisibleNodeHashes,
	registerDiscoveryProvider,
} from '../../discovery/index.mjs'
import { clearLanVisibleNodes, createLanDiscoveryProvider, noteLanVisibleNode } from '../../discovery/lan.mjs'
import {
	clearNostrVisibleNodes,
	createNostrDiscoveryProvider,
	listNostrGroupVisibleNodeHashes,
	listNostrVisibleNodeHashes,
	noteNostrGroupVisibleNode,
	noteNostrVisibleNode,
} from '../../discovery/nostr.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { createMockDiscoveryProvider } from '../helpers/mock_discovery.mjs'

const NET = 'a'.repeat(64)
const GROUP_A = 'b'.repeat(64)
const GROUP_B = 'c'.repeat(64)
const ROOM = 'room-secret-1'

test('nostr network and group visible pools are isolated', () => {
	clearNostrVisibleNodes()
	noteNostrVisibleNode(NET)
	noteNostrGroupVisibleNode(ROOM, GROUP_A)
	assertEquals(listNostrVisibleNodeHashes().includes(NET), true)
	assertEquals(listNostrVisibleNodeHashes().includes(GROUP_A), false)
	assertEquals(listNostrGroupVisibleNodeHashes(ROOM), [GROUP_A])
	assertEquals(listNostrGroupVisibleNodeHashes('other'), [])
	clearNostrVisibleNodes()
})

test('listVisible with roomSecret does not leak network or LAN peers', async () => {
	clearDiscoveryProviders()
	clearNostrVisibleNodes()
	clearLanVisibleNodes()
	noteNostrVisibleNode(NET)
	noteNostrGroupVisibleNode(ROOM, GROUP_A)
	noteLanVisibleNode(GROUP_B)
	registerDiscoveryProvider(createNostrDiscoveryProvider({ relayUrls: [] }))
	registerDiscoveryProvider(createLanDiscoveryProvider())
	assertEquals(new Set(await listVisibleNodeHashes({ limit: 64 })), new Set([NET, GROUP_B]))
	assertEquals(await listVisibleNodeHashes({ roomSecret: ROOM, limit: 64 }), [GROUP_A])
	clearDiscoveryProviders()
	clearNostrVisibleNodes()
	clearLanVisibleNodes()
})

test('mock publishGroupAdvert fills group-visible list', async () => {
	clearDiscoveryProviders()
	const mock = createMockDiscoveryProvider()
	registerDiscoveryProvider(mock)
	mock.publishAdvert(NET, new Uint8Array([1]))
	mock.publishGroupAdvert(ROOM, GROUP_A, new Uint8Array([2]))
	assertEquals(await listVisibleNodeHashes({ limit: 8 }), [NET])
	assertEquals(await listVisibleNodeHashes({ roomSecret: ROOM, limit: 8 }), [GROUP_A])
	clearDiscoveryProviders()
})
