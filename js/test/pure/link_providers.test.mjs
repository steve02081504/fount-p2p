import { Buffer } from 'node:buffer'
import { test } from 'node:test'

import { keyPairFromSeed, pubKeyHash } from '../../crypto/crypto.mjs'
import { normalizeLinkBinding, buildAuth, buildHello, verifyAuth } from '../../link/handshake.mjs'
import {
	clearLinkProviders,
	listAvailableLinkProviders,
	listLinkProviders,
	registerLinkProvider,
	LINK_LEVEL_BLE_GATT,
	LINK_LEVEL_WEBRTC,
} from '../../link/providers/index.mjs'
import { assertEquals } from '../helpers/assert.mjs'

test('listLinkProviders sorts by level descending', () => {
	clearLinkProviders()
	registerLinkProvider({
		id: 'low',
		level: LINK_LEVEL_BLE_GATT,
		/** @returns {boolean} 可用 */
		isAvailable: () => true,
		/** @returns {Promise<never>} 未使用 */
		dial: async () => { throw new Error('unused') },
	})
	registerLinkProvider({
		id: 'high',
		level: LINK_LEVEL_WEBRTC,
		/** @returns {boolean} 可用 */
		isAvailable: () => true,
		/** @returns {Promise<never>} 未使用 */
		dial: async () => { throw new Error('unused') },
	})
	assertEquals(listLinkProviders().map(provider => provider.id), ['high', 'low'])
	clearLinkProviders()
})

test('listAvailableLinkProviders skips unavailable', async () => {
	clearLinkProviders()
	registerLinkProvider({
		id: 'up',
		level: 50,
		/** @returns {boolean} 可用 */
		isAvailable: () => true,
		/** @returns {Promise<never>} 未使用 */
		dial: async () => { throw new Error('unused') },
	})
	registerLinkProvider({
		id: 'down',
		level: 90,
		/** @returns {boolean} 不可用 */
		isAvailable: () => false,
		/** @returns {Promise<never>} 未使用 */
		dial: async () => { throw new Error('unused') },
	})
	registerLinkProvider({
		id: 'boom',
		level: 80,
		/** @returns {Promise<boolean>} 探测失败 */
		isAvailable: async () => { throw new Error('probe fail') },
		/** @returns {Promise<never>} 未使用 */
		dial: async () => { throw new Error('unused') },
	})
	assertEquals((await listAvailableLinkProviders()).map(provider => provider.id), ['up'])
	clearLinkProviders()
})

test('normalizeLinkBinding accepts DTLS fingerprint and hex64 linkId', () => {
	const fingerprint = 'aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99'
	assertEquals(normalizeLinkBinding(fingerprint), fingerprint)
	const linkId = 'ab'.repeat(32)
	assertEquals(normalizeLinkBinding(linkId), linkId)
	assertEquals(normalizeLinkBinding('not-a-binding'), null)
})

test('verifyAuth accepts hex64 linkId binding', async () => {
	const { publicKey, secretKey } = keyPairFromSeed(Buffer.alloc(32, 3))
	const nodeHash = pubKeyHash(publicKey)
	const linkId = 'cd'.repeat(32)
	const hello = buildHello({
		nodeHash,
		nodePubKey: Buffer.from(publicKey).toString('hex'),
		nonce: '44'.repeat(32),
	})
	const auth = await buildAuth(hello.nonce, linkId, { secretKey, nodeHash })
	assertEquals(await verifyAuth(hello, auth, hello.nonce, linkId), nodeHash)
	assertEquals(await verifyAuth(hello, auth, hello.nonce, 'ee'.repeat(32)), null)
})
