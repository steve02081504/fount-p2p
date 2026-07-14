import { Buffer } from 'node:buffer'
import { test } from 'node:test'

/**
 * EVFS chunk + manifest 单元测试。
 */

import { assertSafeEvfsLogicalPath } from '../../core/evfs_logical_path.mjs'
import {
	isLogicalEntityHash,
	logicalEntityHash,
	LOGICAL_ENTITY_SENTINEL_NODE_HASH,
} from '../../core/logical_entity.mjs'
import { encryptPlaintextToParts, buildFileManifest } from '../../files/assemble.mjs'
import { normalizeFileManifest } from '../../files/manifest.mjs'
import { assembleManifestPlaintext } from '../../files/transfer_key.mjs'
import { assertEquals, assertThrows } from '../helpers/assert.mjs'

const TEST_ENTITY = `${'a'.repeat(64)}${'b'.repeat(64)}`
const TEST_GROUP = 'test-group-uuid'
const TEST_GROUP_SUBJECT = `fount:chat:group:${TEST_GROUP}`

test('logicalEntityHash uses sentinel node', () => {
	const eh = logicalEntityHash(TEST_GROUP_SUBJECT)
	assertEquals(eh.slice(0, 64), LOGICAL_ENTITY_SENTINEL_NODE_HASH)
	assertEquals(isLogicalEntityHash(eh), true)
})

test('convergent encrypt-decrypt roundtrip via manifest', async () => {
	const plain = new TextEncoder().encode('hello evfs')
	const enc = encryptPlaintextToParts(plain, 'convergent')
	const manifest = buildFileManifest({
		ownerEntityHash: TEST_ENTITY,
		logicalPath: 'shells/chat/attachments/test',
		plaintext: plain,
		mimeType: 'text/plain',
		ceMode: 'convergent',
	})
	const assembled = await assembleManifestPlaintext(manifest, enc.parts.map(part => part.raw), {})
	assertEquals(assembled?.toString(), 'hello evfs')
})

test('multipart convergent roundtrip keeps per-part contentHash', async () => {
	const { encryptPlaintextToMultiParts } = await import('../../files/assemble.mjs')
	const { FEDERATION_CHUNK_MAX_BYTES } = await import('../../core/constants.mjs')
	const plain = Buffer.alloc(FEDERATION_CHUNK_MAX_BYTES + 1000, 0x42)
	const enc = encryptPlaintextToMultiParts(plain, 'convergent')
	assertEquals(enc.parts.length > 1, true)
	assertEquals(!!enc.parts[0].contentHash, true)
	const manifest = normalizeFileManifest({
		ownerEntityHash: TEST_ENTITY,
		logicalPath: 'shells/chat/attachments/big',
		name: 'big.bin',
		mimeType: 'application/octet-stream',
		size: plain.length,
		contentHash: enc.contentHash,
		ceMode: 'convergent',
		parts: enc.parts.map(part => ({ hash: part.hash, size: part.size, contentHash: part.contentHash })),
		transferKeyDescriptor: { type: 'public' },
	})
	const assembled = await assembleManifestPlaintext(manifest, enc.parts.map(part => part.raw), {})
	assertEquals(Buffer.compare(assembled, plain), 0)
})

test('multipart plaintext stream roundtrip verifies contentHash', async () => {
	const { encryptPlaintextToMultiParts, manifestPartsForPersist } = await import('../../files/assemble.mjs')
	const { createManifestPlaintextStream } = await import('../../files/assemble_stream.mjs')
	const { FEDERATION_CHUNK_MAX_BYTES } = await import('../../core/constants.mjs')
	const { Readable } = await import('node:stream')
	const plain = Buffer.alloc(FEDERATION_CHUNK_MAX_BYTES + 500, 0x37)
	const enc = encryptPlaintextToMultiParts(plain, 'convergent')
	const manifest = normalizeFileManifest({
		ownerEntityHash: TEST_ENTITY,
		logicalPath: 'shells/chat/attachments/streamed',
		name: 'streamed.bin',
		mimeType: 'application/octet-stream',
		size: plain.length,
		contentHash: enc.contentHash,
		ceMode: 'convergent',
		parts: manifestPartsForPersist(enc.parts),
		transferKeyDescriptor: { type: 'public' },
	})
	const stream = createManifestPlaintextStream(manifest, enc.parts.map(part => Readable.from([part.raw])), null)
	/** @type {Buffer[]} */
	const chunks = []
	for await (const chunk of stream) chunks.push(chunk)
	assertEquals(Buffer.compare(Buffer.concat(chunks), plain), 0)

	// 篡改一块密文：流须以错误终止而非静默输出坏数据
	const tampered = enc.parts.map(part => Buffer.from(part.raw))
	tampered[1][40] ^= 0xff
	const badStream = createManifestPlaintextStream(manifest, tampered.map(raw => Readable.from([raw])), null)
	let failed = false
	try {
		for await (const _ of badStream) { /* drain */ }
	}
	catch { failed = true }
	assertEquals(failed, true)
})

test('normalizeFileManifest rejects invalid parts', () => {
	assertEquals(normalizeFileManifest({ ownerEntityHash: 'bad', logicalPath: 'x', parts: [] }), null)
})

test('assertSafeEvfsLogicalPath rejects traversal', () => {
	assertEquals(assertSafeEvfsLogicalPath('shells/chat/foo'), 'shells/chat/foo')
	assertThrows(() => assertSafeEvfsLogicalPath('../etc/passwd'), Error)
	assertThrows(() => assertSafeEvfsLogicalPath('foo/../../bar'), Error)
	assertThrows(() => assertSafeEvfsLogicalPath(''), Error)
})

test('parseEvfsRef rejects malformed refs', async () => {
	const { parseEvfsRef, formatEvfsRef } = await import('../../files/evfs_ref.mjs')
	assertEquals(parseEvfsRef('evfs:abc'), null)
	assertEquals(parseEvfsRef('evfs://'), null)
	const ref = formatEvfsRef(TEST_ENTITY, 'shells/chat/x')
	assertEquals(parseEvfsRef(ref)?.entityHash, TEST_ENTITY)
})

test('manifest acl registry is fail-closed', async () => {
	const { checkManifestAcl } = await import('../../files/manifest_acl_registry.mjs')
	assertEquals(await checkManifestAcl('vault-wrap', { replicaUsername: 'u', ownerEntityHash: 'x', manifest: {} }), false)
	assertEquals(await checkManifestAcl('file-master-key-wrap', { replicaUsername: 'u', ownerEntityHash: 'x', manifest: {} }), false)
})

test('nodeHashFromSeed is stable', async () => {
	const { nodeHashFromSeed } = await import('../../node/identity.mjs')
	const seed = 'a'.repeat(64)
	assertEquals(nodeHashFromSeed(seed), nodeHashFromSeed(seed))
	assertEquals(nodeHashFromSeed(seed) !== nodeHashFromSeed('b'.repeat(64)), true)
})
