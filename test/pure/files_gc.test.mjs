import { Buffer } from 'node:buffer'
import fsp from 'node:fs/promises'
import { test } from 'node:test'

import {
	chunkStoreRoot,
	deleteChunk,
	hasChunk,
	putChunk,
} from '../../files/chunk/store.mjs'
import {
	deleteFileManifest,
	putFileManifest,
} from '../../files/evfs.mjs'
import { cleanChunkGarbage, mapChunkGarbage } from '../../files/gc.mjs'
import { getEntityStore } from '../../node/instance.mjs'
import { assert, assertEquals } from '../helpers/assert.mjs'
import { initTestP2pNode } from '../helpers/node.mjs'
import { mkTestNodeDir, teardownTestNodeDir } from '../helpers/node_dir_leak.mjs'

const OWNER = 'b'.repeat(128)
const ORPHAN = 'c'.repeat(64)

/**
 * @param {string} logicalPath 逻辑路径
 * @param {string} plain 明文
 * @returns {Promise<string>} parts[0] 的 ciphertextHash
 */
async function writePlainFile(logicalPath, plain) {
	const manifest = await putFileManifest({
		ownerEntityHash: OWNER,
		logicalPath,
		plaintext: Buffer.from(plain),
		ceMode: 'plain',
	})
	return manifest.parts[0].hash
}

test('mapChunkGarbage is read-only: reports orphans without deleting', async () => {
	const nodeDir = await mkTestNodeDir('p2p-files-gc-map-')
	try {
		initTestP2pNode({ nodeDir })
		const liveHash = await writePlainFile('a.txt', 'AAA')
		await putChunk(ORPHAN, Buffer.from('ORPHAN'))

		const report = await mapChunkGarbage()
		assertEquals(report.manifests, 1)
		assertEquals(report.referenced, 1)
		assertEquals(report.candidates, [{ hash: ORPHAN, size: 6 }])
		assertEquals(report.freedBytes, 6)
		assertEquals(report.deleted, 0)

		assertEquals(await hasChunk(ORPHAN), true)
		assertEquals(await hasChunk(liveHash), true)
	}
	finally {
		await teardownTestNodeDir(nodeDir)
	}
})

test('cleanChunkGarbage reaps overwritten chunks and keeps live ones', async () => {
	const nodeDir = await mkTestNodeDir('p2p-files-gc-overwrite-')
	try {
		initTestP2pNode({ nodeDir })
		const oldHash = await writePlainFile('a.txt', 'V1')
		const newHash = await writePlainFile('a.txt', 'V2')
		assertEquals(oldHash === newHash, false)

		const report = await cleanChunkGarbage()
		assertEquals(report.deleted, 1)
		assertEquals(report.freedBytes, 2)
		assertEquals(await hasChunk(oldHash), false)
		assertEquals(await hasChunk(newHash), true)

		const prefixes = await fsp.readdir(chunkStoreRoot())
		if (oldHash.slice(0, 2) !== newHash.slice(0, 2))
			assertEquals(prefixes.includes(oldHash.slice(0, 2)), false)
	}
	finally {
		await teardownTestNodeDir(nodeDir)
	}
})

test('cleanChunkGarbage keeps chunks shared across manifests', async () => {
	const nodeDir = await mkTestNodeDir('p2p-files-gc-shared-')
	try {
		initTestP2pNode({ nodeDir })
		const sharedHash = await writePlainFile('x.txt', 'SAME')
		const sharedAgain = await writePlainFile('y.txt', 'SAME')
		assertEquals(sharedHash, sharedAgain)
		await putChunk(ORPHAN, Buffer.from('ORPHAN'))

		const report = await cleanChunkGarbage()
		assertEquals(report.deleted, 1)
		assertEquals(await hasChunk(sharedHash), true)
		assertEquals(await hasChunk(ORPHAN), false)
	}
	finally {
		await teardownTestNodeDir(nodeDir)
	}
})

test('cleanChunkGarbage({ targets }) removes only the given set', async () => {
	const nodeDir = await mkTestNodeDir('p2p-files-gc-targets-')
	try {
		initTestP2pNode({ nodeDir })
		const liveHash = await writePlainFile('a.txt', 'AAA')
		const orphanOne = 'd'.repeat(64)
		const orphanTwo = 'e'.repeat(64)
		await putChunk(orphanOne, Buffer.from('BBBB'))
		await putChunk(orphanTwo, Buffer.from('CCCC'))

		const partial = await cleanChunkGarbage({ targets: [orphanOne] })
		assertEquals(partial.deleted, 1)
		assertEquals(await hasChunk(orphanOne), false)
		assertEquals(await hasChunk(orphanTwo), true)
		assertEquals(await hasChunk(liveHash), true)

		const full = await cleanChunkGarbage()
		assertEquals(full.deleted, 1)
		assertEquals(await hasChunk(orphanTwo), false)
		assertEquals(await hasChunk(liveHash), true)
	}
	finally {
		await teardownTestNodeDir(nodeDir)
	}
})

test('cleanChunkGarbage({ targets }) rejects invalid hashes', async () => {
	const nodeDir = await mkTestNodeDir('p2p-files-gc-targets-invalid-')
	try {
		initTestP2pNode({ nodeDir })
		await assert.rejects(
			cleanChunkGarbage({ targets: ['0xdeadbeef'] }),
			/invalid chunk hash/,
		)
	}
	finally {
		await teardownTestNodeDir(nodeDir)
	}
})

test('cleanChunkGarbage removes broken manifests and reaps their orphans', async () => {
	const nodeDir = await mkTestNodeDir('p2p-files-gc-broken-')
	try {
		initTestP2pNode({ nodeDir })
		const liveHash = await writePlainFile('a.txt', 'AAA')
		await getEntityStore().writeManifest(OWNER, 'broken.txt', { foo: 'bar' })
		await putChunk(ORPHAN, Buffer.from('ORPHAN'))

		const mapped = await mapChunkGarbage()
		assertEquals(mapped.brokenManifests, [{ ownerEntityHash: OWNER, logicalPath: 'broken.txt' }])
		assertEquals(mapped.candidates, [{ hash: ORPHAN, size: 6 }])

		const report = await cleanChunkGarbage()
		assertEquals(report.brokenDeleted, 1)
		assertEquals(await getEntityStore().statManifest(OWNER, 'broken.txt'), false)
		assertEquals(await hasChunk(ORPHAN), false)
		assertEquals(await hasChunk(liveHash), true)
	}
	finally {
		await teardownTestNodeDir(nodeDir)
	}
})

test('deleteFileManifest orphans its chunks for later GC', async () => {
	const nodeDir = await mkTestNodeDir('p2p-files-gc-delete-manifest-')
	try {
		initTestP2pNode({ nodeDir })
		const hash = await writePlainFile('a.txt', 'AAA')
		await deleteFileManifest(OWNER, 'a.txt')
		assertEquals(await getEntityStore().statManifest(OWNER, 'a.txt'), false)

		const report = await cleanChunkGarbage()
		assertEquals(report.deleted, 1)
		assertEquals(await hasChunk(hash), false)
	}
	finally {
		await teardownTestNodeDir(nodeDir)
	}
})

test('deleteChunk is a standalone primitive', async () => {
	const nodeDir = await mkTestNodeDir('p2p-files-gc-delete-chunk-')
	try {
		initTestP2pNode({ nodeDir })
		await putChunk(ORPHAN, Buffer.from('X'))
		assertEquals(await hasChunk(ORPHAN), true)

		const result = await deleteChunk(ORPHAN)
		assertEquals(result, { deleted: true, size: 1 })
		assertEquals(await hasChunk(ORPHAN), false)

		assertEquals(await deleteChunk(ORPHAN), { deleted: true, size: 0 })
	}
	finally {
		await teardownTestNodeDir(nodeDir)
	}
})
