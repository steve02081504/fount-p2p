import { test } from 'node:test'

import {
	LAN_PEER_HINT_TTL_MS,
	clearLanPeerHints,
	getLanPeerHint,
	listLanPeerHints,
	noteLanPeerHint,
} from '../../discovery/lan_peer_hints.mjs'
import { assertEquals } from '../helpers/assert.mjs'

test('lan peer hints store and expire by TTL', () => {
	clearLanPeerHints()
	const nodeHash = 'ab'.repeat(32)
	noteLanPeerHint(nodeHash, { host: '127.0.0.1', port: 4242 })
	const t0 = Date.now()
	assertEquals(getLanPeerHint(nodeHash, t0)?.host, '127.0.0.1')
	assertEquals(getLanPeerHint(nodeHash, t0)?.port, 4242)
	noteLanPeerHint('nope', { host: '', port: 1 })
	assertEquals(getLanPeerHint('nope', t0), null)
	noteLanPeerHint(nodeHash, { host: '10.0.0.2', port: 99999 })
	assertEquals(getLanPeerHint(nodeHash, t0)?.host, '127.0.0.1')
	assertEquals(getLanPeerHint(nodeHash, t0 + LAN_PEER_HINT_TTL_MS + 1), null)
	clearLanPeerHints()
	assertEquals(getLanPeerHint(nodeHash, t0), null)
})

test('lan peer hints keep newest observation first', () => {
	clearLanPeerHints()
	const nodeHash = 'cd'.repeat(32)
	noteLanPeerHint(nodeHash, { host: '10.0.0.1', port: 1000 })
	noteLanPeerHint(nodeHash, { host: '10.0.0.2', port: 1000 })
	noteLanPeerHint(nodeHash, { host: '10.0.0.1', port: 1000 })
	assertEquals(listLanPeerHints(nodeHash), [
		{ host: '10.0.0.1', port: 1000 },
		{ host: '10.0.0.2', port: 1000 },
	])
})
