import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { cachePublicManifest } from '../../files/manifest_fetch.mjs'
import { startNode } from '../../index.mjs'
import {
	getNodeLogger,
	getSignalingRuntimeConfig,
	initNode,
	onNodeChange,
	resetNodeForTests,
	setNodeLogger,
	setSignalingRuntimeConfig,
} from '../../node/instance.mjs'
import {
	attachReputationSyncWire,
	getReputationLocks,
	getReputationTable,
	lockReputationMax,
	resetReputationSyncForTests,
	setReputationExportAllowlist,
	setReputationTable,
	unlockReputationMax,
} from '../../node/reputation_sync.mjs'
import { resolveSignalingRuntimeConfig } from '../../node/signaling_config.mjs'
import {
	configureLinkRegistry,
	getLinkRegistry,
	resetLinkRegistryForTests,
} from '../../transport/link_registry.mjs'
import {
	attachNodeScopeChunks,
	dispatchNodeScopeAction,
	ensureNodeScope,
	getNodeScopeContext,
	hasNodeScopeAction,
	stopNodeScopeRuntime,
} from '../../transport/node_scope.mjs'
import { ensureUserRoom } from '../../transport/user_room.mjs'

const HASH_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const HASH_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

/**
 * @returns {Promise<string>} 临时 node 目录路径
 */
async function tmpNodeDir() {
	return mkdtemp(path.join(os.tmpdir(), 'p2p-edge-'))
}

/**
 * @returns {void}
 */
function resetAll() {
	resetNodeForTests()
	resetLinkRegistryForTests()
	resetReputationSyncForTests()
	stopNodeScopeRuntime()
}

test('resolveSignalingRuntimeConfig merges patch including relayOverride', () => {
	const config = resolveSignalingRuntimeConfig({
		relayOverride: ['wss://relay.example/'],
		iceLocalHostnamePolicy: 'none',
		trickleIceOff: false,
	})
	assert.deepEqual(config.relayOverride, ['wss://relay.example/'])
	assert.equal(config.iceLocalHostnamePolicy, 'none')
	assert.equal(config.trickleIceOff, false)
})

test('setNodeLogger(null) disables logger; second initNode throws', async () => {
	const nodeDir = await tmpNodeDir()
	try {
		resetAll()
		assert.throws(() => initNode({ nodeDir, logger: null }), /only accepts nodeDir/)
		initNode({ nodeDir })
		assert.equal(getNodeLogger(), console)
		setNodeLogger(null)
		assert.equal(getNodeLogger(), null)
		assert.doesNotThrow(() => getNodeLogger()?.warn?.('noop'))
		assert.throws(() => initNode({ nodeDir }), /already called/)
	}
	finally {
		resetAll()
		await rm(nodeDir, { recursive: true, force: true })
	}
})

test('facade exports attachReputationSyncWire', async () => {
	const facade = await import('../../index.mjs')
	assert.equal(typeof facade.attachReputationSyncWire, 'function')
})

test('startNode after init rejects conflicting options; setSignalingRuntimeConfig emits', async () => {
	const nodeDir = await tmpNodeDir()
	try {
		resetAll()
		initNode({ nodeDir })
		await startNode()
		await assert.rejects(() => startNode({ nodeDir }), /ignored after initNode/)
		let saw = null
		const off = onNodeChange((event, payload) => { saw = { event, payload } })
		setSignalingRuntimeConfig({ relayOverride: ['wss://hot.example/'] })
		off()
		assert.equal(saw?.event, 'signaling-changed')
		assert.deepEqual(getSignalingRuntimeConfig().relayOverride, ['wss://hot.example/'])
		assert.equal(typeof getLinkRegistry().reloadDiscoveryRelays, 'function')
	}
	finally {
		resetAll()
		await rm(nodeDir, { recursive: true, force: true })
	}
})

test('ensureUserRoom default does not attach full wires', async () => {
	const nodeDir = await tmpNodeDir()
	try {
		resetAll()
		configureLinkRegistry({ autoRegisterDiscoveryProviders: false, autoRegisterLinkProviders: false })
		initNode({ nodeDir })
		await ensureUserRoom()
		assert.equal(hasNodeScopeAction('mailbox_put'), false)
		assert.equal(hasNodeScopeAction('part_timeline_put'), false)
		await ensureUserRoom({ attachDefaultWires: true })
		assert.equal(hasNodeScopeAction('mailbox_put'), true)
	}
	finally {
		resetAll()
		await rm(nodeDir, { recursive: true, force: true })
	}
})

test('chunk attach reads live replicaUsername', async () => {
	const nodeDir = await tmpNodeDir()
	try {
		resetAll()
		initNode({ nodeDir })
		ensureNodeScope({ replicaUsername: 'alice' })
		attachNodeScopeChunks()
		assert.equal(getNodeScopeContext().replicaUsername, 'alice')
		ensureNodeScope({ replicaUsername: 'bob' })
		assert.equal(getNodeScopeContext().replicaUsername, 'bob')
	}
	finally {
		resetAll()
		await rm(nodeDir, { recursive: true, force: true })
	}
})

test('lockReputationMax forces score to 1; unlock restores prior score', async () => {
	const nodeDir = await tmpNodeDir()
	try {
		resetAll()
		initNode({ nodeDir })
		await setReputationTable({ byNodeHash: { [HASH_A]: { score: 0.2 } } })
		await lockReputationMax([HASH_A])
		assert.equal(getReputationTable().byNodeHash[HASH_A].score, 1)
		assert.deepEqual(getReputationLocks(), [HASH_A])
		await unlockReputationMax([HASH_A])
		assert.deepEqual(getReputationLocks(), [])
		assert.equal(getReputationTable().byNodeHash[HASH_A].score, 0.2)
	}
	finally {
		resetAll()
		await rm(nodeDir, { recursive: true, force: true })
	}
})

test('rep_sync_req responds for allowlisted peer without writing caller table', async () => {
	const nodeDir = await tmpNodeDir()
	try {
		resetAll()
		initNode({ nodeDir })
		await setReputationTable({ byNodeHash: { [HASH_A]: { score: 0.77 } } })
		setReputationExportAllowlist([HASH_B])
		attachReputationSyncWire()
		const wire = (await import('../../transport/node_scope.mjs')).getNodeScopeWire()
		/** @type {unknown} */
		let sent = null
		const original = wire.send
		/**
		 * 测试桩：拦截 wire.send 以断言出站载荷。
		 * @param {string} name - action 名
		 * @param {unknown} payload - 发送载荷
		 * @param {string} peerId - 目标 peer
		 * @returns {void}
		 */
		wire.send = (name, payload, peerId) => { sent = { name, payload, peerId } }
		assert.equal(dispatchNodeScopeAction('rep_sync_req', { requestId: 'r1' }, HASH_B), true)
		wire.send = original
		assert.equal(sent?.name, 'rep_sync_res')
		assert.equal(sent?.payload.requestId, 'r1')
		assert.equal(sent?.payload.byNodeHash[HASH_A].score, 0.77)
		assert.equal(sent?.peerId, HASH_B)
	}
	finally {
		resetAll()
		await rm(nodeDir, { recursive: true, force: true })
	}
})

test('fetchPublicManifest returns null on bad input without hanging; cache is opt-in export', async () => {
	const miss = await (await import('../../files/manifest_fetch.mjs')).fetchPublicManifest({
		username: '',
		ownerEntityHash: '',
		logicalPath: '',
	})
	assert.equal(miss, null)
	assert.equal(typeof cachePublicManifest, 'function')
})
