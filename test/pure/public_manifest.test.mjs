import { Buffer } from 'node:buffer'
import { test } from 'node:test'

import { entityHashFromRecoveryPubKeyHex } from '../../core/entity_id.mjs'
import { logicalEntityHash } from '../../core/logical_entity.mjs'
import { keyPairFromSeed } from '../../crypto/crypto.mjs'
import { encryptPlaintextToParts, buildFileManifestFromEnc } from '../../files/assemble.mjs'
import { loadFileManifest, readPublicFile, storeManifestParts } from '../../files/evfs.mjs'
import { cachePublicManifest, fetchManifest } from '../../files/manifest/fetch.mjs'
import { publicTransferKeyDescriptor } from '../../files/manifest/normalize.mjs'
import {
	manifestFetchExpectedKey,
	pendingManifestFetches,
	registerManifestFetchWait,
	resolvePendingManifestFetch,
} from '../../files/manifest/pending.mjs'
import {
	attachPublicManifestSig,
	publishPublicFile,
	shouldPreferIncomingPublicManifest,
	verifySignedPublicManifest,
} from '../../files/manifest/public.mjs'
import { getNodeHash } from '../../node/identity.mjs'
import { ms } from '../../utils/duration.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { initTestP2pNode } from '../helpers/node.mjs'
import { mkTestNodeDir } from '../helpers/node_dir_leak.mjs'

/**
 * @param {number} [timeoutMs] 等待上限
 * @returns {Promise<string | null>} 首个 pending requestId
 */
async function waitForPendingManifestRequestId(timeoutMs = ms('2s')) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const [requestId] = pendingManifestFetches.keys()
		if (requestId) return requestId
		await new Promise(resolve => setTimeout(resolve, 5))
	}
	return null
}

/** 结算残留 pending，避免 SWR 提前返回后的 fanout 污染后续用例。 */
function settleAllPendingManifestFetches() {
	for (const [key, entry] of [...pendingManifestFetches.entries()]) {
		clearTimeout(entry.timer)
		pendingManifestFetches.delete(key)
		entry.finish(null)
	}
}

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
		ms('2s'),
	)
	assertEquals(await resolvePendingManifestFetch({ requestId, manifest: signed }), true)
	const got = await done
	assertEquals(got?.logicalPath, 'profile.json')
	assertEquals(got?.meta?.publicSig?.publishedAt, 500)
})

test('publishPublicFile writes verifiable public manifest', async () => {
	initTestP2pNode({ nodeDir: await mkTestNodeDir('fount-pub-manifest-') })
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

test('fed_manifest_get refuses non-public manifest without registered servicer', async () => {
	initTestP2pNode({ nodeDir: await mkTestNodeDir('fount-fed-manifest-priv-') })
	const { handleIncomingManifestGet } = await import('../../files/manifest/fetch.mjs')
	const { getEntityStore } = await import('../../node/instance.mjs')
	const owner = entityHashFromRecoveryPubKeyHex(getNodeHash(), testRecoveryKeys(10).pubKeyHex)
	const plaintext = Buffer.from('secret')
	await getEntityStore().writeManifest(owner, 'vault/secret.bin', buildFileManifestFromEnc({
		ownerEntityHash: owner,
		logicalPath: 'vault/secret.bin',
		plaintext,
		name: 'secret.bin',
		mimeType: 'application/octet-stream',
		ceMode: 'convergent',
		transferKeyDescriptor: { type: 'vault-wrap', entityHash: owner },
	}, encryptPlaintextToParts(plaintext, 'convergent')))
	let called = false
	await handleIncomingManifestGet({
		requestId: 'r1',
		ownerEntityHash: owner,
		logicalPath: 'vault/secret.bin',
	}, () => { called = true }, 'a'.repeat(64))
	assertEquals(called, false)
})

test('fed_manifest_get serves non-public manifest when servicer allows', async () => {
	initTestP2pNode({ nodeDir: await mkTestNodeDir('fount-fed-manifest-servicer-') })
	const { handleIncomingManifestGet } = await import('../../files/manifest/fetch.mjs')
	const { registerManifestOwner, unregisterManifestOwner } = await import('../../files/manifest/routing.mjs')
	const { registerManifestServicer, unregisterManifestServicer } = await import('../../files/manifest/servicer_registry.mjs')
	const { getEntityStore } = await import('../../node/instance.mjs')
	const owner = entityHashFromRecoveryPubKeyHex(getNodeHash(), testRecoveryKeys(18).pubKeyHex)
	const plaintext = Buffer.from('secret')
	await getEntityStore().writeManifest(owner, 'vault/secret.bin', buildFileManifestFromEnc({
		ownerEntityHash: owner,
		logicalPath: 'vault/secret.bin',
		plaintext,
		name: 'secret.bin',
		mimeType: 'application/octet-stream',
		ceMode: 'convergent',
		transferKeyDescriptor: { type: 'vault-wrap', entityHash: owner },
		meta: { dagParts: [{ hash: 'a'.repeat(64) }], groupId: 'g1' },
	}, encryptPlaintextToParts(plaintext, 'convergent')))

	/** @type {object | null} */
	let seen
	registerManifestOwner('test', (manifest, ownerEntityHash) => ownerEntityHash === owner)
	registerManifestServicer('test', async context => {
		seen = context
		return true
	})
	try {
		/** @type {object | null} */
		let response = null
		await handleIncomingManifestGet({
			requestId: 'r2',
			ownerEntityHash: owner,
			logicalPath: 'vault/secret.bin',
		}, payload => { response = payload }, 'b'.repeat(64))
		assertEquals(response?.requestId, 'r2')
		// 非 public 回完整 manifest（含 meta.dagParts / groupId），读侧解密依赖它们
		assertEquals(response?.manifest?.transferKeyDescriptor?.type, 'vault-wrap')
		assertEquals(response?.manifest?.meta?.groupId, 'g1')
		assertEquals(response?.manifest?.meta?.dagParts?.length, 1)
		// 请求方身份透传给 servicer（来自传输层认证的 peerId，非自报 nodeHash）
		assertEquals(seen?.requesterNodeHash, 'b'.repeat(64))
		assertEquals(seen?.peerId, 'b'.repeat(64))
		assertEquals(seen?.logicalPath, 'vault/secret.bin')
	}
	finally {
		unregisterManifestServicer('test')
		unregisterManifestOwner('test')
	}
})

test('fed_manifest_get refuses non-public manifest when servicer denies', async () => {
	initTestP2pNode({ nodeDir: await mkTestNodeDir('fount-fed-manifest-deny-') })
	const { handleIncomingManifestGet } = await import('../../files/manifest/fetch.mjs')
	const { registerManifestOwner, unregisterManifestOwner } = await import('../../files/manifest/routing.mjs')
	const { registerManifestServicer, unregisterManifestServicer } = await import('../../files/manifest/servicer_registry.mjs')
	const { getEntityStore } = await import('../../node/instance.mjs')
	const owner = entityHashFromRecoveryPubKeyHex(getNodeHash(), testRecoveryKeys(19).pubKeyHex)
	const plaintext = Buffer.from('secret')
	await getEntityStore().writeManifest(owner, 'vault/secret.bin', buildFileManifestFromEnc({
		ownerEntityHash: owner,
		logicalPath: 'vault/secret.bin',
		plaintext,
		name: 'secret.bin',
		mimeType: 'application/octet-stream',
		ceMode: 'convergent',
		transferKeyDescriptor: { type: 'vault-wrap', entityHash: owner },
	}, encryptPlaintextToParts(plaintext, 'convergent')))

	registerManifestOwner('test', (manifest, ownerEntityHash) => ownerEntityHash === owner)
	registerManifestServicer('test', async () => false)
	try {
		let called = false
		await handleIncomingManifestGet({
			requestId: 'r3',
			ownerEntityHash: owner,
			logicalPath: 'vault/secret.bin',
		}, () => { called = true }, 'c'.repeat(64))
		assertEquals(called, false)
	}
	finally {
		unregisterManifestServicer('test')
		unregisterManifestOwner('test')
	}
})

test('fed_manifest_get refuses public manifest without publicSig', async () => {
	initTestP2pNode({ nodeDir: await mkTestNodeDir('fount-fed-manifest-nosig-') })
	const { handleIncomingManifestGet } = await import('../../files/manifest/fetch.mjs')
	const { getEntityStore } = await import('../../node/instance.mjs')
	const owner = entityHashFromRecoveryPubKeyHex(getNodeHash(), testRecoveryKeys(11).pubKeyHex)
	const plaintext = Buffer.from('x')
	await getEntityStore().writeManifest(owner, 'profile.json', buildFileManifestFromEnc({
		ownerEntityHash: owner,
		logicalPath: 'profile.json',
		plaintext,
		name: 'profile.json',
		mimeType: 'application/json',
		ceMode: 'convergent',
		transferKeyDescriptor: publicTransferKeyDescriptor(),
	}, encryptPlaintextToParts(plaintext, 'convergent')))
	let called = false
	await handleIncomingManifestGet({
		requestId: 'r2',
		ownerEntityHash: owner,
		logicalPath: 'profile.json',
	}, () => { called = true }, 'peer')
	assertEquals(called, false)
})

test('fed_manifest_get responds with publicSig-only meta', async () => {
	initTestP2pNode({ nodeDir: await mkTestNodeDir('fount-fed-manifest-ok-') })
	const { handleIncomingManifestGet } = await import('../../files/manifest/fetch.mjs')
	const keys = testRecoveryKeys(12)
	const owner = entityHashFromRecoveryPubKeyHex(getNodeHash(), keys.pubKeyHex)
	const published = await publishPublicFile({
		ownerEntityHash: owner,
		logicalPath: 'profile.json',
		plaintext: Buffer.from('{}'),
		name: 'profile.json',
		mimeType: 'application/json',
		entitySecretKey: keys.secretKey,
		entityPubKeyHex: keys.pubKeyHex,
		publishedAt: 800,
	})
	// 本地扩展不应外泄
	const { getEntityStore } = await import('../../node/instance.mjs')
	await getEntityStore().writeManifest(owner, 'profile.json', {
		...published,
		meta: { ...published.meta, groupId: 'local-only', dagParts: [{ hash: 'a'.repeat(64) }] },
	})
	/** @type {object | null} */
	let resp = null
	await handleIncomingManifestGet({
		requestId: 'r3',
		ownerEntityHash: owner,
		logicalPath: 'profile.json',
	}, (payload) => { resp = payload }, 'peer')
	assertEquals(resp?.requestId, 'r3')
	assertEquals(Object.keys(resp?.manifest?.meta || {}), ['publicSig'])
	assertEquals(resp?.manifest?.meta?.publicSig?.publishedAt, 800)
	assertEquals(resp?.manifest?.transferKeyDescriptor?.type, 'public')
})

test('fetchManifest returns local publicSig immediately without awaiting fanout', async () => {
	settleAllPendingManifestFetches()
	initTestP2pNode({ nodeDir: await mkTestNodeDir('fount-fetch-pub-swr-fast-') })
	const keys = testRecoveryKeys(13)
	const owner = entityHashFromRecoveryPubKeyHex('a'.repeat(64), keys.pubKeyHex)
	const local = await buildSignedManifest(owner, 'profile.json', 'cached', keys, 1500)
	await cachePublicManifest(owner, 'profile.json', local)

	const started = Date.now()
	assertEquals((await fetchManifest({
		username: 'u',
		ownerEntityHash: owner,
		logicalPath: 'profile.json',
		timeoutMs: ms('8s'),
	}))?.meta?.publicSig?.publishedAt, 1500)
	assertEquals(Date.now() - started < 500, true)
	// fanout 仍在飞，供后台刷新
	assertEquals(Boolean(await waitForPendingManifestRequestId()), true)
	settleAllPendingManifestFetches()
})

test('fetchManifest revalidates local publicSig in background and caches newer publishedAt', async () => {
	settleAllPendingManifestFetches()
	initTestP2pNode({ nodeDir: await mkTestNodeDir('fount-fetch-pub-revalidate-') })
	const keys = testRecoveryKeys(14)
	const owner = entityHashFromRecoveryPubKeyHex('b'.repeat(64), keys.pubKeyHex)
	const older = await buildSignedManifest(owner, 'profile.json', 'v1', keys, 1000)
	const newer = await buildSignedManifest(owner, 'profile.json', 'v2', keys, 2000)
	await cachePublicManifest(owner, 'profile.json', older)

	assertEquals((await fetchManifest({
		username: 'u',
		ownerEntityHash: owner,
		logicalPath: 'profile.json',
		cache: true,
	}))?.meta?.publicSig?.publishedAt, 1000)

	const requestId = await waitForPendingManifestRequestId()
	assertEquals(Boolean(requestId), true)
	assertEquals(await resolvePendingManifestFetch({ requestId, manifest: newer }), true)

	const deadline = Date.now() + ms('2s')
	let cachedAt = 1000
	while (Date.now() < deadline) {
		cachedAt = (await loadFileManifest(owner, 'profile.json'))?.meta?.publicSig?.publishedAt
		if (cachedAt === 2000) break
		await new Promise(resolve => setTimeout(resolve, 5))
	}
	assertEquals(cachedAt, 2000)
	settleAllPendingManifestFetches()
})

test('fetchManifest keeps local when incoming publishedAt is not newer', async () => {
	settleAllPendingManifestFetches()
	initTestP2pNode({ nodeDir: await mkTestNodeDir('fount-fetch-pub-keep-local-') })
	const keys = testRecoveryKeys(15)
	const owner = entityHashFromRecoveryPubKeyHex('c'.repeat(64), keys.pubKeyHex)
	const newer = await buildSignedManifest(owner, 'profile.json', 'v2', keys, 2000)
	const older = await buildSignedManifest(owner, 'profile.json', 'v1', keys, 1000)
	await cachePublicManifest(owner, 'profile.json', newer)

	assertEquals((await fetchManifest({
		username: 'u',
		ownerEntityHash: owner,
		logicalPath: 'profile.json',
		cache: true,
	}))?.meta?.publicSig?.publishedAt, 2000)

	const requestId = await waitForPendingManifestRequestId()
	assertEquals(Boolean(requestId), true)
	assertEquals(await resolvePendingManifestFetch({ requestId, manifest: older }), true)
	await new Promise(resolve => setTimeout(resolve, 30))
	assertEquals((await loadFileManifest(owner, 'profile.json'))?.meta?.publicSig?.publishedAt, 2000)
	settleAllPendingManifestFetches()
})

test('fetchManifest revalidate:true blocks and returns newer manifest from fanout', async () => {
	settleAllPendingManifestFetches()
	initTestP2pNode({ nodeDir: await mkTestNodeDir('fount-fetch-pub-revalidate-block-') })
	const keys = testRecoveryKeys(31)
	const owner = entityHashFromRecoveryPubKeyHex('f0'.repeat(32), keys.pubKeyHex)
	const older = await buildSignedManifest(owner, 'profile.json', 'v1', keys, 1000)
	const newer = await buildSignedManifest(owner, 'profile.json', 'v2', keys, 2000)
	await cachePublicManifest(owner, 'profile.json', older)

	/** @type {boolean} */
	let settled = false
	const fetchPromise = fetchManifest({
		username: 'u',
		ownerEntityHash: owner,
		logicalPath: 'profile.json',
		cache: true,
		revalidate: true,
	}).then(result => {
		settled = true
		return result
	})

	const requestId = await waitForPendingManifestRequestId()
	assertEquals(Boolean(requestId), true)
	// 阻塞等待 fanout：结算前不得返回本地旧清单
	assertEquals(settled, false)
	assertEquals(await resolvePendingManifestFetch({ requestId, manifest: newer }), true)
	assertEquals((await fetchPromise)?.meta?.publicSig?.publishedAt, 2000)
	// 择新已写回本地缓存
	assertEquals((await loadFileManifest(owner, 'profile.json'))?.meta?.publicSig?.publishedAt, 2000)
	settleAllPendingManifestFetches()
})

test('fetchManifest revalidate:true keeps local when fanout yields nothing newer', async () => {
	settleAllPendingManifestFetches()
	initTestP2pNode({ nodeDir: await mkTestNodeDir('fount-fetch-pub-revalidate-older-') })
	const keys = testRecoveryKeys(32)
	const owner = entityHashFromRecoveryPubKeyHex('f1'.repeat(32), keys.pubKeyHex)
	const newer = await buildSignedManifest(owner, 'profile.json', 'v2', keys, 2000)
	const older = await buildSignedManifest(owner, 'profile.json', 'v1', keys, 1000)
	await cachePublicManifest(owner, 'profile.json', newer)

	const fetchPromise = fetchManifest({
		username: 'u',
		ownerEntityHash: owner,
		logicalPath: 'profile.json',
		cache: true,
		revalidate: true,
	})
	const requestId = await waitForPendingManifestRequestId()
	assertEquals(Boolean(requestId), true)
	assertEquals(await resolvePendingManifestFetch({ requestId, manifest: older }), true)
	assertEquals((await fetchPromise)?.meta?.publicSig?.publishedAt, 2000)
	assertEquals((await loadFileManifest(owner, 'profile.json'))?.meta?.publicSig?.publishedAt, 2000)
	settleAllPendingManifestFetches()
})

test('fetchManifest revalidate:true falls back to local when fanout times out', async () => {
	settleAllPendingManifestFetches()
	initTestP2pNode({ nodeDir: await mkTestNodeDir('fount-fetch-pub-revalidate-timeout-') })
	const keys = testRecoveryKeys(33)
	const owner = entityHashFromRecoveryPubKeyHex('f2'.repeat(32), keys.pubKeyHex)
	const local = await buildSignedManifest(owner, 'profile.json', 'cached', keys, 1000)
	await cachePublicManifest(owner, 'profile.json', local)

	const started = Date.now()
	const result = await fetchManifest({
		username: 'u',
		ownerEntityHash: owner,
		logicalPath: 'profile.json',
		cache: true,
		revalidate: true,
		timeoutMs: 200,
	})
	assertEquals(result?.meta?.publicSig?.publishedAt, 1000)
	// 确曾阻塞等待 fanout 超时（而非立即返回本地）
	assertEquals(Date.now() - started >= 150, true)
	settleAllPendingManifestFetches()
})

test('readPublicFile revalidate:true returns republished plaintext on one read', async () => {
	settleAllPendingManifestFetches()
	initTestP2pNode({ nodeDir: await mkTestNodeDir('fount-read-pub-revalidate-') })
	const keys = testRecoveryKeys(34)
	const owner = entityHashFromRecoveryPubKeyHex('f3'.repeat(32), keys.pubKeyHex)
	const older = await buildSignedManifest(owner, 'profile.json', 'cached', keys, 1000)
	const newer = await buildSignedManifest(owner, 'profile.json', 'new', keys, 2000)
	// 新旧两版明文块均预存，chunk miss 不依赖网络
	await storeManifestParts(older, encryptPlaintextToParts(Buffer.from('cached'), 'convergent').parts.map(part => part.raw))
	await storeManifestParts(newer, encryptPlaintextToParts(Buffer.from('new'), 'convergent').parts.map(part => part.raw))
	await cachePublicManifest(owner, 'profile.json', older)

	const readPromise = readPublicFile('u', owner, 'profile.json', { revalidate: true })
	const requestId = await waitForPendingManifestRequestId()
	assertEquals(Boolean(requestId), true)
	assertEquals(await resolvePendingManifestFetch({ requestId, manifest: newer }), true)
	assertEquals((await readPromise).toString('utf8'), 'new')
	settleAllPendingManifestFetches()
})

test('fetchManifest cold miss still awaits fanout', async () => {
	settleAllPendingManifestFetches()
	initTestP2pNode({ nodeDir: await mkTestNodeDir('fount-fetch-pub-cold-') })
	const keys = testRecoveryKeys(16)
	const owner = entityHashFromRecoveryPubKeyHex('d'.repeat(64), keys.pubKeyHex)
	const signed = await buildSignedManifest(owner, 'profile.json', 'cold', keys, 3000)

	const fetchPromise = fetchManifest({
		username: 'u',
		ownerEntityHash: owner,
		logicalPath: 'profile.json',
		cache: true,
	})
	const requestId = await waitForPendingManifestRequestId()
	assertEquals(Boolean(requestId), true)
	assertEquals(await resolvePendingManifestFetch({ requestId, manifest: signed }), true)
	assertEquals((await fetchPromise)?.meta?.publicSig?.publishedAt, 3000)
	settleAllPendingManifestFetches()
})

test('fetchManifest dedups concurrent in-flight by username+owner+path', async () => {
	settleAllPendingManifestFetches()
	initTestP2pNode({ nodeDir: await mkTestNodeDir('fount-fetch-pub-dedup-') })
	const keys = testRecoveryKeys(17)
	const owner = entityHashFromRecoveryPubKeyHex('e'.repeat(64), keys.pubKeyHex)
	const signed = await buildSignedManifest(owner, 'profile.json', 'once', keys, 3000)

	const p1 = fetchManifest({
		username: 'u',
		ownerEntityHash: owner,
		logicalPath: 'profile.json',
		cache: true,
	})
	const p2 = fetchManifest({
		username: 'u',
		ownerEntityHash: owner,
		logicalPath: 'profile.json',
		cache: true,
	})
	const requestId = await waitForPendingManifestRequestId()
	assertEquals(Boolean(requestId), true)
	assertEquals(pendingManifestFetches.size, 1)

	assertEquals(await resolvePendingManifestFetch({ requestId, manifest: signed }), true)
	const [a, b] = await Promise.all([p1, p2])
	assertEquals(a?.meta?.publicSig?.publishedAt, 3000)
	assertEquals(b?.meta?.publicSig?.publishedAt, 3000)
	settleAllPendingManifestFetches()
})

/**
 * @param {string} ownerEntityHash owner
 * @param {string} logicalPath 路径
 * @param {string} plain 明文
 * @param {string} type transferKeyDescriptor.type
 * @returns {Promise<import('../../files/manifest/normalize.mjs').FileManifest>} 非 public manifest
 */
async function buildNonPublicManifest(ownerEntityHash, logicalPath, plain, type) {
	const plaintext = Buffer.from(plain)
	return buildFileManifestFromEnc({
		ownerEntityHash,
		logicalPath,
		plaintext,
		name: 'x',
		mimeType: 'text/plain',
		ceMode: 'convergent',
		transferKeyDescriptor: { type, entityHash: ownerEntityHash },
		meta: { dagParts: [{ hash: 'a'.repeat(64) }], groupId: 'g1' },
	}, encryptPlaintextToParts(plaintext, 'convergent'))
}

test('fetchManifest targeted cold miss resolves non-public and caches locally', async () => {
	settleAllPendingManifestFetches()
	initTestP2pNode({ nodeDir: await mkTestNodeDir('fount-fetch-tgt-nonpub-') })
	const owner = entityHashFromRecoveryPubKeyHex('f'.repeat(64), testRecoveryKeys(20).pubKeyHex)
	const manifest = await buildNonPublicManifest(owner, 'chat/file-1', 'secret', 'file-master-key-wrap')

	const fetchPromise = fetchManifest({
		username: 'u',
		ownerEntityHash: owner,
		logicalPath: 'chat/file-1',
		fanoutTargets: ['b'.repeat(64)],
	})
	const requestId = await waitForPendingManifestRequestId()
	assertEquals(Boolean(requestId), true)
	assertEquals(await resolvePendingManifestFetch({ requestId, manifest, senderNodeHash: 'b'.repeat(64) }), true)
	const got = await fetchPromise
	assertEquals(got?.transferKeyDescriptor?.type, 'file-master-key-wrap')
	assertEquals(got?.meta?.groupId, 'g1')
	// targeted 命中默认落盘
	const cached = await loadFileManifest(owner, 'chat/file-1')
	assertEquals(cached?.transferKeyDescriptor?.type, 'file-master-key-wrap')
	settleAllPendingManifestFetches()
})

test('fetchManifest targeted accepts signed public response too', async () => {
	settleAllPendingManifestFetches()
	initTestP2pNode({ nodeDir: await mkTestNodeDir('fount-fetch-tgt-public-') })
	const keys = testRecoveryKeys(21)
	const owner = entityHashFromRecoveryPubKeyHex('1'.repeat(64), keys.pubKeyHex)
	const signed = await buildSignedManifest(owner, 'profile.json', 'pub', keys, 4000)

	const fetchPromise = fetchManifest({
		username: 'u',
		ownerEntityHash: owner,
		logicalPath: 'profile.json',
		fanoutTargets: ['2'.repeat(64)],
	})
	const requestId = await waitForPendingManifestRequestId()
	assertEquals(Boolean(requestId), true)
	assertEquals(await resolvePendingManifestFetch({ requestId, manifest: signed }), true)
	assertEquals((await fetchPromise)?.meta?.publicSig?.publishedAt, 4000)
	settleAllPendingManifestFetches()
})

test('fetchManifest public mode refuses non-public response', async () => {
	settleAllPendingManifestFetches()
	initTestP2pNode({ nodeDir: await mkTestNodeDir('fount-fetch-pub-refuse-nonpub-') })
	const owner = entityHashFromRecoveryPubKeyHex('3'.repeat(64), testRecoveryKeys(22).pubKeyHex)
	const manifest = await buildNonPublicManifest(owner, 'chat/file-1', 'secret', 'file-master-key-wrap')

	const fetchPromise = fetchManifest({
		username: 'u',
		ownerEntityHash: owner,
		logicalPath: 'chat/file-1',
		timeoutMs: 500,
	})
	const requestId = await waitForPendingManifestRequestId()
	assertEquals(Boolean(requestId), true)
	assertEquals(await resolvePendingManifestFetch({ requestId, manifest }), false)
	assertEquals(await fetchPromise, null)
	settleAllPendingManifestFetches()
})

test('fetchManifest targeted returns local non-public manifest immediately without fanout wait', async () => {
	settleAllPendingManifestFetches()
	initTestP2pNode({ nodeDir: await mkTestNodeDir('fount-fetch-local-nonpub-') })
	const { getEntityStore } = await import('../../node/instance.mjs')
	const owner = entityHashFromRecoveryPubKeyHex('4'.repeat(64), testRecoveryKeys(23).pubKeyHex)
	await getEntityStore().writeManifest(owner, 'vault/secret.bin', await buildNonPublicManifest(owner, 'vault/secret.bin', 'secret', 'vault-wrap'))

	const started = Date.now()
	assertEquals((await fetchManifest({
		username: 'u',
		ownerEntityHash: owner,
		logicalPath: 'vault/secret.bin',
		fanoutTargets: ['10'.repeat(32)],
	}))?.transferKeyDescriptor?.type, 'vault-wrap')
	assertEquals(Date.now() - started < 500, true)
	settleAllPendingManifestFetches()
})

test('fetchManifest targeted dedups concurrent in-flight', async () => {
	settleAllPendingManifestFetches()
	initTestP2pNode({ nodeDir: await mkTestNodeDir('fount-fetch-tgt-dedup-') })
	const owner = entityHashFromRecoveryPubKeyHex('5'.repeat(64), testRecoveryKeys(24).pubKeyHex)
	const manifest = await buildNonPublicManifest(owner, 'chat/file-1', 'secret', 'file-master-key-wrap')
	const targets = ['6'.repeat(64)]

	const firstFetch = fetchManifest({
		username: 'u',
		ownerEntityHash: owner,
		logicalPath: 'chat/file-1',
		fanoutTargets: targets,
	})
	const secondFetch = fetchManifest({
		username: 'u',
		ownerEntityHash: owner,
		logicalPath: 'chat/file-1',
		fanoutTargets: targets,
	})
	const requestId = await waitForPendingManifestRequestId()
	assertEquals(Boolean(requestId), true)
	assertEquals(pendingManifestFetches.size, 1)
	assertEquals(await resolvePendingManifestFetch({ requestId, manifest, senderNodeHash: '6'.repeat(64) }), true)
	const [firstManifest, secondManifest] = await Promise.all([firstFetch, secondFetch])
	assertEquals(firstManifest?.transferKeyDescriptor?.type, 'file-master-key-wrap')
	assertEquals(secondManifest?.transferKeyDescriptor?.type, 'file-master-key-wrap')
	settleAllPendingManifestFetches()
})

test('fetchManifest targeted rejects non-public response from sender outside target set', async () => {
	settleAllPendingManifestFetches()
	initTestP2pNode({ nodeDir: await mkTestNodeDir('fount-fetch-tgt-sender-reject-') })
	const owner = entityHashFromRecoveryPubKeyHex('7'.repeat(64), testRecoveryKeys(25).pubKeyHex)
	const manifest = await buildNonPublicManifest(owner, 'chat/file-1', 'secret', 'file-master-key-wrap')

	const fetchPromise = fetchManifest({
		username: 'u',
		ownerEntityHash: owner,
		logicalPath: 'chat/file-1',
		fanoutTargets: ['8'.repeat(64)],
	})
	const requestId = await waitForPendingManifestRequestId()
	assertEquals(Boolean(requestId), true)
	// 注入：sender 不在目标集 → 拒绝
	assertEquals(await resolvePendingManifestFetch({ requestId, manifest, senderNodeHash: '9'.repeat(64) }), false)
	// 目标集内 sender → 接受
	assertEquals(await resolvePendingManifestFetch({ requestId, manifest, senderNodeHash: '8'.repeat(64) }), true)
	assertEquals((await fetchPromise)?.transferKeyDescriptor?.type, 'file-master-key-wrap')
	settleAllPendingManifestFetches()
})

test('fetchManifest targeted does not dedup different target sets', async () => {
	settleAllPendingManifestFetches()
	initTestP2pNode({ nodeDir: await mkTestNodeDir('fount-fetch-tgt-key-') })
	const owner = entityHashFromRecoveryPubKeyHex('ab'.repeat(32), testRecoveryKeys(26).pubKeyHex)

	const firstFetch = fetchManifest({
		username: 'u',
		ownerEntityHash: owner,
		logicalPath: 'chat/file-1',
		fanoutTargets: ['cd'.repeat(32)],
	})
	const secondFetch = fetchManifest({
		username: 'u',
		ownerEntityHash: owner,
		logicalPath: 'chat/file-1',
		fanoutTargets: ['ef'.repeat(32)],
	})
	const deadline = Date.now() + ms('2s')
	while (Date.now() < deadline && pendingManifestFetches.size < 2)
		await new Promise(resolve => setTimeout(resolve, 5))
	assertEquals(pendingManifestFetches.size, 2)
	settleAllPendingManifestFetches()
	await Promise.all([firstFetch, secondFetch])
})

test('fetchManifest public mode refuses local non-public manifest', async () => {
	settleAllPendingManifestFetches()
	initTestP2pNode({ nodeDir: await mkTestNodeDir('fount-fetch-pub-refuse-local-nonpub-') })
	const { getEntityStore } = await import('../../node/instance.mjs')
	const owner = entityHashFromRecoveryPubKeyHex('de'.repeat(32), testRecoveryKeys(27).pubKeyHex)
	await getEntityStore().writeManifest(owner, 'vault/secret.bin', await buildNonPublicManifest(owner, 'vault/secret.bin', 'secret', 'vault-wrap'))

	assertEquals(await fetchManifest({
		username: 'u',
		ownerEntityHash: owner,
		logicalPath: 'vault/secret.bin',
	}), null)
	settleAllPendingManifestFetches()
})

test('fed_manifest_get serves fanout request with requester differing from target node', async () => {
	initTestP2pNode({ nodeDir: await mkTestNodeDir('fount-fed-manifest-fanout-') })
	const { handleIncomingManifestGet } = await import('../../files/manifest/fetch.mjs')
	const { registerManifestOwner, unregisterManifestOwner } = await import('../../files/manifest/routing.mjs')
	const { registerManifestServicer, unregisterManifestServicer } = await import('../../files/manifest/servicer_registry.mjs')
	const { getEntityStore } = await import('../../node/instance.mjs')
	const owner = entityHashFromRecoveryPubKeyHex(getNodeHash(), testRecoveryKeys(28).pubKeyHex)
	const plaintext = Buffer.from('secret')
	await getEntityStore().writeManifest(owner, 'vault/secret.bin', buildFileManifestFromEnc({
		ownerEntityHash: owner,
		logicalPath: 'vault/secret.bin',
		plaintext,
		name: 'secret.bin',
		mimeType: 'application/octet-stream',
		ceMode: 'convergent',
		transferKeyDescriptor: { type: 'vault-wrap', entityHash: owner },
	}, encryptPlaintextToParts(plaintext, 'convergent')))

	/** @type {object | null} */
	let seen
	registerManifestOwner('test', (manifest, ownerEntityHash) => ownerEntityHash === owner)
	registerManifestServicer('test', async context => {
		seen = context
		return true
	})
	try {
		/** @type {object | null} */
		let response = null
		const requesterNodeHash = 'a'.repeat(64)
		const targetNodeHash = 'b'.repeat(64)
		// fanout：同一请求发给多个目标节点；自报 nodeHash 指向目标节点，而认证方为请求方（二者不同）。
		// 服务端必须忽略自报字段，始终以传输层认证的 peerId 作为 requesterNodeHash，不得误作目标节点身份。
		await handleIncomingManifestGet({
			requestId: 'r4',
			nodeHash: targetNodeHash,
			ownerEntityHash: owner,
			logicalPath: 'vault/secret.bin',
		}, payload => { response = payload }, requesterNodeHash)
		assertEquals(response?.requestId, 'r4')
		assertEquals(seen?.requesterNodeHash, requesterNodeHash)
		assertEquals(seen?.peerId, requesterNodeHash)
		assertEquals(seen?.logicalPath, 'vault/secret.bin')
	}
	finally {
		unregisterManifestServicer('test')
		unregisterManifestOwner('test')
	}
})

test('fed_manifest_get routes non-public by matcher owner, not by type', async () => {
	initTestP2pNode({ nodeDir: await mkTestNodeDir('fount-fed-manifest-owner-route-') })
	const { handleIncomingManifestGet } = await import('../../files/manifest/fetch.mjs')
	const { registerManifestOwner, unregisterManifestOwner } = await import('../../files/manifest/routing.mjs')
	const { registerManifestServicer, unregisterManifestServicer } = await import('../../files/manifest/servicer_registry.mjs')
	const { getEntityStore } = await import('../../node/instance.mjs')

	// chat 与 cabinet 同用 file-master-key-wrap；各自 matcher 收窄到自己的实体
	const chatGroup = logicalEntityHash('fount:chat:group:g1')
	const cabinetShared = logicalEntityHash('fount:cabinet:shared:c1')
	const noFamilyOwner = entityHashFromRecoveryPubKeyHex(getNodeHash(), testRecoveryKeys(30).pubKeyHex)
	for (const [ownerEntityHash, logicalPath] of [[chatGroup, 'chat/file-1'], [cabinetShared, 'shared/file-1'], [noFamilyOwner, 'nofamily/file-1']])
		await getEntityStore().writeManifest(ownerEntityHash, logicalPath, await buildNonPublicManifest(ownerEntityHash, logicalPath, 'secret', 'file-master-key-wrap'))

	/** @type {string[]} */
	const served = []
	registerManifestOwner('chat', (manifest, ownerEntityHash) => ownerEntityHash === chatGroup)
	registerManifestOwner('cabinet', (manifest, ownerEntityHash) => ownerEntityHash === cabinetShared)
	registerManifestServicer('chat', async context => { served.push('chat'); return true })
	registerManifestServicer('cabinet', async context => { served.push('cabinet'); return true })

	/**
	 * @param {string} ownerEntityHash owner
	 * @param {string} logicalPath 路径
	 * @returns {Promise<object | null>} manifest 响应
	 */
	const serve = async (ownerEntityHash, logicalPath) => {
		/** @type {object | null} */
		let response = null
		await handleIncomingManifestGet({ requestId: 'r', ownerEntityHash, logicalPath }, payload => { response = payload }, 'peer')
		return response
	}

	try {
		// 相同 type 两族并存：chat 文件 → chat servicer，cabinet 文件 → cabinet servicer
		assertEquals((await serve(chatGroup, 'chat/file-1'))?.manifest?.ownerEntityHash, chatGroup)
		assertEquals(served, ['chat'])
		assertEquals((await serve(cabinetShared, 'shared/file-1'))?.manifest?.ownerEntityHash, cabinetShared)
		assertEquals(served, ['chat', 'cabinet'])
		// 无 matcher 命中：即使该 type 已有 servicer，也一律 deny（不再按 type 兜底路由）
		assertEquals(await serve(noFamilyOwner, 'nofamily/file-1'), null)
		assertEquals(served, ['chat', 'cabinet'])
	}
	finally {
		unregisterManifestServicer('chat')
		unregisterManifestServicer('cabinet')
		unregisterManifestOwner('chat')
		unregisterManifestOwner('cabinet')
	}
})
