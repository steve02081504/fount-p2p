import { Buffer } from 'node:buffer'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { entityHashFromRecoveryPubKeyHex } from '../../core/entity_id.mjs'
import { keyPairFromSeed } from '../../crypto/crypto.mjs'
import {
	manifestFetchExpectedKey,
	registerManifestFetchWait,
	resolvePendingManifestFetch,
} from '../../federation/manifest_fetch_pending.mjs'
import { encryptPlaintextToParts, buildFileManifestFromEnc } from '../../files/assemble.mjs'
import { publicTransferKeyDescriptor } from '../../files/manifest.mjs'
import {
	attachPublicManifestSig,
	publishPublicFile,
	shouldPreferIncomingPublicManifest,
	verifySignedPublicManifest,
} from '../../files/public_manifest.mjs'
import { getNodeHash } from '../../node/identity.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { initTestP2pNode } from '../helpers/node.mjs'

/**
 * @param {number} [n] 种子盐
 * @returns {{ secretKey: Uint8Array, publicKey: Uint8Array, pubKeyHex: string }} 测试用 recovery 密钥对
 */
function testRecoveryKeys(n = 1) {
	const kp = keyPairFromSeed(Buffer.from(`public-manifest-test-seed-${n}`.padEnd(32, '0')))
	return {
		secretKey: kp.secretKey,
		publicKey: kp.publicKey,
		pubKeyHex: Buffer.from(kp.publicKey).toString('hex'),
	}
}

/**
 * @param {string} ownerEntityHash owner
 * @param {string} logicalPath 路径
 * @param {string} plain 明文
 * @param {{ secretKey: Uint8Array, pubKeyHex: string }} keys 签名密钥
 * @param {number} publishedAt 发布时间
 * @returns {Promise<object>} 已签名原始清单对象
 */
async function buildSignedManifest(ownerEntityHash, logicalPath, plain, keys, publishedAt) {
	const plaintext = Buffer.from(plain)
	const enc = encryptPlaintextToParts(plaintext, 'convergent')
	const base = buildFileManifestFromEnc({
		ownerEntityHash,
		logicalPath,
		plaintext,
		name: 'x',
		mimeType: 'text/plain',
		ceMode: 'convergent',
		transferKeyDescriptor: publicTransferKeyDescriptor(),
	}, enc)
	return attachPublicManifestSig(base, publishedAt, keys.secretKey, keys.pubKeyHex)
}

test('public manifest sign/verify roundtrip', async () => {
	const keys = testRecoveryKeys(1)
	const nodeHash = 'a'.repeat(64)
	const owner = entityHashFromRecoveryPubKeyHex(nodeHash, keys.pubKeyHex)
	const signed = await buildSignedManifest(owner, 'profile.json', 'hello', keys, 1_700_000_000_000)
	const verified = await verifySignedPublicManifest(signed)
	assertEquals(verified?.ownerEntityHash, owner)
	assertEquals(verified?.logicalPath, 'profile.json')
	assertEquals(verified?.meta?.publicSig?.publishedAt, 1_700_000_000_000)
})

test('public manifest rejects tampered parts', async () => {
	const keys = testRecoveryKeys(2)
	const owner = entityHashFromRecoveryPubKeyHex('b'.repeat(64), keys.pubKeyHex)
	const signed = await buildSignedManifest(owner, 'profile/avatar', 'img', keys, 100)
	signed.parts = [{ ...signed.parts[0], hash: 'c'.repeat(64) }]
	assertEquals(await verifySignedPublicManifest(signed), null)
})

test('public manifest rejects wrong owner / path / non-public', async () => {
	const keys = testRecoveryKeys(3)
	const owner = entityHashFromRecoveryPubKeyHex('d'.repeat(64), keys.pubKeyHex)
	const signed = await buildSignedManifest(owner, 'a', 'x', keys, 200)

	const wrongOwner = { ...signed, ownerEntityHash: entityHashFromRecoveryPubKeyHex('e'.repeat(64), keys.pubKeyHex) }
	assertEquals(await verifySignedPublicManifest(wrongOwner), null)

	const wrongPath = { ...signed, logicalPath: 'b' }
	assertEquals(await verifySignedPublicManifest(wrongPath), null)

	const privateMk = {
		...signed,
		transferKeyDescriptor: { type: 'vault-wrap', entityHash: owner },
	}
	assertEquals(await verifySignedPublicManifest(privateMk), null)
})

test('public manifest rejects wrong recovery key for entityHash', async () => {
	const keysA = testRecoveryKeys(4)
	const keysB = testRecoveryKeys(5)
	const owner = entityHashFromRecoveryPubKeyHex('f'.repeat(64), keysA.pubKeyHex)
	const signed = await buildSignedManifest(owner, 'p', 'x', keysB, 300)
	assertEquals(await verifySignedPublicManifest(signed), null)
})

test('verify strips unsigned meta extensions from incoming manifest', async () => {
	const keys = testRecoveryKeys(9)
	const owner = entityHashFromRecoveryPubKeyHex('9'.repeat(64), keys.pubKeyHex)
	const signed = await buildSignedManifest(owner, 'p', 'x', keys, 700)
	const poisoned = structuredClone(signed)
	poisoned.meta.groupId = 'evil-group'
	poisoned.meta.dagParts = [{ hash: 'a'.repeat(64) }]
	const verified = await verifySignedPublicManifest(poisoned)
	assertEquals(Object.keys(verified.meta), ['publicSig'])
	assertEquals(verified.meta.publicSig.publishedAt, 700)
})

test('shouldPreferIncomingPublicManifest by publishedAt', () => {
	const older = { meta: { publicSig: { publishedAt: 10 } } }
	const newer = { meta: { publicSig: { publishedAt: 20 } } }
	assertEquals(shouldPreferIncomingPublicManifest(older, newer), true)
	assertEquals(shouldPreferIncomingPublicManifest(newer, older), false)
	assertEquals(shouldPreferIncomingPublicManifest(null, newer), true)
	assertEquals(shouldPreferIncomingPublicManifest(older, { meta: {} }), false)
})

test('fake manifest data does not resolve pending wait', async () => {
	const keys = testRecoveryKeys(6)
	const owner = entityHashFromRecoveryPubKeyHex('1'.repeat(64), keys.pubKeyHex)
	const signed = await buildSignedManifest(owner, 'profile.json', 'ok', keys, 400)
	const bad = structuredClone(signed)
	bad.meta.publicSig.sigHex = 'a'.repeat(128)

	const requestId = 'pending-manifest-fake-1'
	const { done } = registerManifestFetchWait(
		requestId,
		manifestFetchExpectedKey(owner, 'profile.json'),
		200,
	)
	assertEquals(await resolvePendingManifestFetch({ requestId, manifest: bad }), false)
	assertEquals(await resolvePendingManifestFetch({
		requestId,
		manifest: { ...signed, logicalPath: 'other.json' },
	}), false)
	assertEquals(await done, null)
})

test('valid manifest data resolves pending wait', async () => {
	const keys = testRecoveryKeys(7)
	const owner = entityHashFromRecoveryPubKeyHex('2'.repeat(64), keys.pubKeyHex)
	const signed = await buildSignedManifest(owner, 'profile.json', 'ok', keys, 500)
	const requestId = 'pending-manifest-ok-1'
	const { done } = registerManifestFetchWait(
		requestId,
		manifestFetchExpectedKey(owner, 'profile.json'),
		2000,
	)
	assertEquals(await resolvePendingManifestFetch({ requestId, manifest: signed }), true)
	const got = await done
	assertEquals(got?.logicalPath, 'profile.json')
	assertEquals(got?.meta?.publicSig?.publishedAt, 500)
})

test('publishPublicFile writes verifiable public manifest', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'fount-pub-manifest-'))
	initTestP2pNode({ nodeDir: dir })
	const keys = testRecoveryKeys(8)
	const owner = entityHashFromRecoveryPubKeyHex(getNodeHash(), keys.pubKeyHex)
	const published = await publishPublicFile({
		ownerEntityHash: owner,
		logicalPath: 'profile.json',
		plaintext: Buffer.from(JSON.stringify({ name: 't' })),
		name: 'profile.json',
		mimeType: 'application/json',
		entitySecretKey: keys.secretKey,
		entityPubKeyHex: keys.pubKeyHex,
		publishedAt: 600,
	})
	const verified = await verifySignedPublicManifest(published)
	assertEquals(verified?.meta?.publicSig?.publishedAt, 600)
	assertEquals(verified?.transferKeyDescriptor?.type, 'public')
})
