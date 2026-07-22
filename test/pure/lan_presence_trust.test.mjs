import { Buffer } from 'node:buffer'
import { createSocket } from 'node:dgram'
import { test } from 'node:test'

import { keyPairFromSeed, pubKeyHash } from '../../crypto/crypto.mjs'
import { buildSignedAdvertForScope, encryptAdvertForScope } from '../../discovery/adverts.mjs'
import {
	acceptLanPresenceAdvert,
	clearLanVisibleNodes,
	createLanDiscoveryProvider,
	listLanVisibleNodeHashes,
} from '../../discovery/lan.mjs'
import { clearLanPeerHints, getLanPeerHint } from '../../discovery/lan_peer_hints.mjs'
import { assertEquals } from '../helpers/assert.mjs'

const FAKE = 'f'.repeat(64)
const PORT = 53597

test('LAN unsigned presence does not enter visible pool or peer hints', async () => {
	clearLanVisibleNodes()
	clearLanPeerHints()
	const provider = createLanDiscoveryProvider({ port: PORT, group: '239.255.42.91' })
	const stop = await provider.startPresence(async () => null)
	const sock = createSocket('udp4')
	try {
		await new Promise((resolve, reject) => {
			sock.send(
				JSON.stringify({ type: 'presence', nodeHash: FAKE, tcpPort: 19090, host: '10.0.0.8' }),
				PORT,
				'127.0.0.1',
				error => error ? reject(error) : resolve(),
			)
		})
		await new Promise(resolve => setTimeout(resolve, 150))
		assertEquals(listLanVisibleNodeHashes().includes(FAKE), false)
		assertEquals(getLanPeerHint(FAKE), null)
	}
	finally {
		sock.close()
		stop()
		clearLanVisibleNodes()
		clearLanPeerHints()
	}
})

test('LAN signed network advert enters visible pool and peer hints', async () => {
	clearLanVisibleNodes()
	clearLanPeerHints()
	const seed = Buffer.alloc(32, 9)
	const { publicKey, secretKey } = keyPairFromSeed(seed)
	const nodeHash = pubKeyHash(publicKey)
	const localIdentity = {
		nodeHash,
		nodePubKey: Buffer.from(publicKey).toString('hex'),
		secretKey,
	}
	const body = await buildSignedAdvertForScope('network', localIdentity, 19091)
	const advertBytes = encryptAdvertForScope('network', localIdentity, body)
	const ingested = await acceptLanPresenceAdvert(advertBytes, { address: '10.0.0.8' })
	assertEquals(ingested?.verifiedNodeHash, nodeHash)
	assertEquals(listLanVisibleNodeHashes().includes(nodeHash), true)
	assertEquals(getLanPeerHint(nodeHash), { host: '10.0.0.8', port: 19091 })
	clearLanVisibleNodes()
	clearLanPeerHints()
})
