import { test } from 'node:test'


/**
 * EVFS chunk + manifest 单元测试（Deno）。
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
