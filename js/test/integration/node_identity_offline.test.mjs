import { strict as assert } from 'node:assert'
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'

import { keyPairFromSeed } from '../../crypto/crypto.mjs'
import {
	ensureNodeSeed,
	getNodeHash,
	nodeHashFromSeed,
	resolveLocalEntityHashFromRecoveryPubKeyHex,
} from '../../node/identity.mjs'
import {
	closeNode,
	configureNodeStorage,
	getEntityStore,
	getNode,
	getNodeDir,
	initNode,
	isNodeInitialized,
} from '../../node/instance.mjs'
import { readNodeJsonSync, writeNodeJsonSync } from '../../node/storage.mjs'
import { mkTestNodeDir, teardownTestNodeDir } from '../helpers/node_dir_leak.mjs'

/** 起始每个用例前清空运行时与存储配置。 */
async function resetNode() {
	await closeNode()
}

test('configureNodeStorage enables local identity derivation without initNode', async () => {
	const nodeDir = await mkTestNodeDir('p2p-offline-')
	try {
		await resetNode()
		const configured = configureNodeStorage({ nodeDir })
		assert.equal(configured, getNodeDir())
		assert.equal(isNodeInitialized(), false)
		assert.throws(() => getNode(), /not initialized/)
		assert.throws(() => getEntityStore(), /not initialized/)

		const recoveryPubKeyHex = Buffer.from(keyPairFromSeed(randomBytes(32)).publicKey).toString('hex')
		const entityHash = resolveLocalEntityHashFromRecoveryPubKeyHex(recoveryPubKeyHex)
		assert.equal(typeof entityHash, 'string')
		assert.equal(entityHash.length, 128)
		assert.equal(isNodeInitialized(), false)
	}
	finally {
		await teardownTestNodeDir(nodeDir)
	}
})

test('seed persists across reconfigure and closeNode', async () => {
	const nodeDir = await mkTestNodeDir('p2p-offline-')
	try {
		await resetNode()
		configureNodeStorage({ nodeDir })
		const seed = ensureNodeSeed()
		assert.equal(seed.length, 64)
		assert.equal(ensureNodeSeed(), seed)

		configureNodeStorage({ nodeDir })
		assert.equal(ensureNodeSeed(), seed)

		await closeNode()
		configureNodeStorage({ nodeDir })
		assert.equal(ensureNodeSeed(), seed)
	}
	finally {
		await teardownTestNodeDir(nodeDir)
	}
})

test('existing node.json seed and extra fields are preserved', async () => {
	const nodeDir = await mkTestNodeDir('p2p-offline-')
	try {
		await resetNode()
		configureNodeStorage({ nodeDir })
		const seed = 'a'.repeat(64)
		writeNodeJsonSync('node', { nodeSeedHex: seed, customField: 'keep-me' })
		assert.equal(ensureNodeSeed(), seed)
		assert.equal(getNodeHash(), nodeHashFromSeed(seed))
		assert.equal(readNodeJsonSync('node').customField, 'keep-me')
	}
	finally {
		await teardownTestNodeDir(nodeDir)
	}
})

test('offline identity hashes survive a later initNode on the same dir', async () => {
	const nodeDir = await mkTestNodeDir('p2p-offline-')
	try {
		await resetNode()
		configureNodeStorage({ nodeDir })
		const recoveryPubKeyHex = Buffer.from(keyPairFromSeed(randomBytes(32)).publicKey).toString('hex')
		const offlineNodeHash = getNodeHash()
		const offlineEntityHash = resolveLocalEntityHashFromRecoveryPubKeyHex(recoveryPubKeyHex)

		initNode({ nodeDir })
		assert.equal(isNodeInitialized(), true)
		assert.equal(getNodeHash(), offlineNodeHash)
		assert.equal(resolveLocalEntityHashFromRecoveryPubKeyHex(recoveryPubKeyHex), offlineEntityHash)
	}
	finally {
		await teardownTestNodeDir(nodeDir)
	}
})

test('switching dir is rejected while running; allowed after closeNode', async () => {
	const dirA = await mkTestNodeDir('p2p-offline-a-')
	const dirB = await mkTestNodeDir('p2p-offline-b-')
	try {
		await resetNode()
		configureNodeStorage({ nodeDir: dirA })
		const seedA = ensureNodeSeed()
		initNode({ nodeDir: dirA })
		assert.throws(() => configureNodeStorage({ nodeDir: dirB }), /another nodeDir/)
		assert.throws(() => initNode({ nodeDir: dirB }), /already called/)

		await closeNode()
		configureNodeStorage({ nodeDir: dirB })
		const seedB = ensureNodeSeed()
		assert.notEqual(seedA, seedB)

		configureNodeStorage({ nodeDir: dirA })
		assert.equal(ensureNodeSeed(), seedA)
	}
	finally {
		await closeNode()
		await teardownTestNodeDir(dirA)
		await teardownTestNodeDir(dirB)
	}
})

test('unconfigured and invalid dir raise explicit errors', async () => {
	await resetNode()
	assert.throws(() => getNodeDir(), /not configured/)
	assert.throws(() => ensureNodeSeed(), /not configured/)
	assert.throws(() => configureNodeStorage({}), /requires nodeDir/)
	assert.throws(() => configureNodeStorage({ nodeDir: '' }), /requires nodeDir/)
})

test('facade exposes configureNodeStorage', async () => {
	const facade = await import('../../index.mjs')
	assert.equal(typeof facade.configureNodeStorage, 'function')
})
