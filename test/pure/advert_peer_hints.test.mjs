import { test } from 'node:test'

import { noteAdvertPeerHints } from '../../discovery/advert_peer_hints.mjs'
import { clearBtPeerHints, getBtPeerHint } from '../../discovery/bt/peer_hints.mjs'
import { clearLanPeerHints, getLanPeerHint, listLanPeerHints } from '../../discovery/lan_peer_hints.mjs'
import { assertEquals } from '../helpers/assert.mjs'

const nodeHash = 'a'.repeat(64)

test('noteAdvertPeerHints records LAN and BT from advert body + meta', () => {
	clearLanPeerHints()
	clearBtPeerHints()
	noteAdvertPeerHints(nodeHash, { tcpPort: 18080 }, {
		address: '10.0.0.5',
		peripheralId: 'aa:bb:cc:dd:ee:ff',
	})
	const lan = getLanPeerHint(nodeHash)
	assertEquals(lan?.host, '10.0.0.5')
	assertEquals(lan?.port, 18080)
	assertEquals(getBtPeerHint(nodeHash)?.peripheralId, 'aa:bb:cc:dd:ee:ff')
})

test('noteAdvertPeerHints records LAN hints from signed lanHosts when meta has no address', () => {
	clearLanPeerHints()
	clearBtPeerHints()
	noteAdvertPeerHints(nodeHash, { tcpPort: 18080, lanHosts: ['192.168.1.10', '10.0.0.5'] }, {})
	assertEquals(listLanPeerHints(nodeHash), [
		{ host: '192.168.1.10', port: 18080 },
		{ host: '10.0.0.5', port: 18080 },
	])
})

test('noteAdvertPeerHints prefers meta.address over body lanHosts', () => {
	clearLanPeerHints()
	clearBtPeerHints()
	noteAdvertPeerHints(nodeHash, {
		tcpPort: 18080,
		lanHosts: ['192.168.1.10', '10.0.0.5'],
	}, { address: '10.0.0.9' })
	assertEquals(listLanPeerHints(nodeHash), [
		{ host: '10.0.0.9', port: 18080 },
		{ host: '192.168.1.10', port: 18080 },
		{ host: '10.0.0.5', port: 18080 },
	])
})

test('noteAdvertPeerHints ignores incomplete LAN endpoint', () => {
	clearLanPeerHints()
	clearBtPeerHints()
	noteAdvertPeerHints(nodeHash, { tcpPort: 18080 }, { address: '' })
	assertEquals(getLanPeerHint(nodeHash), null)
	noteAdvertPeerHints(nodeHash, {}, { address: '10.0.0.5' })
	assertEquals(getLanPeerHint(nodeHash), null)
	noteAdvertPeerHints(nodeHash, { tcpPort: 99999 }, { address: '10.0.0.5' })
	assertEquals(getLanPeerHint(nodeHash), null)
})
