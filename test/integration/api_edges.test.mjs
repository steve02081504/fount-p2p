import { strict as assert } from 'node:assert'
import { Buffer } from 'node:buffer'
import { test } from 'node:test'

import { createChunkReadStream, putChunk } from '../../files/chunk/store.mjs'
import { cachePublicManifest } from '../../files/manifest/fetch.mjs'
import { startNode } from '../../index.mjs'
import { hasOpenFileStreams } from '../../node/handles.mjs'
import {
	closeNode,
	getNodeLogger,
	getSignalingRuntimeConfig,
	initNode,
	onNodeChange,
	setNodeLogger,
	setSignalingRuntimeConfig,
} from '../../node/instance.mjs'
import { loadReputation } from '../../node/reputation_store.mjs'
import {
	attachReputationSyncWire,
	getReputationLocks,
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
	stopNodeScopeRuntime,
} from '../../transport/node_scope/features.mjs'
import {
	dispatchNodeScopeAction,
	ensureNodeScope,
	getNodeScopeContext,
	getNodeScopeWire,
	hasNodeScopeAction,
	registerNodeScopeWireHook,
} from '../../transport/node_scope/wire.mjs'
import { ensureUserRoom } from '../../transport/user_room.mjs'
import { mkTestNodeDir, teardownTestNodeDir } from '../helpers/node_dir_leak.mjs'

const HASH_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const HASH_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

/** 重置节点、registry、rep sync 与 node scope */
function resetAll() {
	closeNode()
	resetLinkRegistryForTests()
	resetReputationSyncForTests()
	stopNodeScopeRuntime()
}

test('resolveSignalingRuntimeConfig merges patch including channel relay', () => {
	const config = resolveSignalingRuntimeConfig({
		channels: {
			nostr: { relay: ['wss://relay.example/'] },
			webrtc: { iceLocalHostnamePolicy: 'none', trickleIceOff: false },
		},
	})
	assert.deepEqual(config.channels.nostr.relay, ['wss://relay.example/'])
	assert.equal(config.channels.webrtc.iceLocalHostnamePolicy, 'none')
	assert.equal(config.channels.webrtc.trickleIceOff, false)
})

test('setNodeLogger(null) disables logger; second initNode throws', async () => {
	const nodeDir = await mkTestNodeDir('p2p-edge-')
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
		await teardownTestNodeDir(nodeDir)
	}
})

test('facade exports attachReputationSyncWire', async () => {
	const facade = await import('../../index.mjs')
	assert.equal(typeof facade.attachReputationSyncWire, 'function')
})

test('closeNode releases open chunk streams so nodeDir is deletable', async () => {
	const nodeDir = await mkTestNodeDir('p2p-edge-')
	try {
		resetAll()
		initNode({ nodeDir })
		const hash = '1111111111111111111111111111111111111111111111111111111111111111'
		await putChunk(hash, Buffer.from('payload'))
		createChunkReadStream(hash)
		assert.equal(hasOpenFileStreams(), true)
		await closeNode()
		assert.equal(hasOpenFileStreams(), false)
	}
	finally {
		await teardownTestNodeDir(nodeDir)
	}
})

test('closeNode is exported from facade and closes handles', async () => {
	const facade = await import('../../index.mjs')
	assert.equal(typeof facade.closeNode, 'function')
	const nodeDir = await mkTestNodeDir('p2p-edge-')
	try {
		await facade.closeNode()
		initNode({ nodeDir })
		const hash = '2222222222222222222222222222222222222222222222222222222222222222'
		await putChunk(hash, Buffer.from('payload'))
		createChunkReadStream(hash)
		assert.equal(hasOpenFileStreams(), true)
		await facade.closeNode()
		assert.equal(hasOpenFileStreams(), false)
	}
	finally {
		await teardownTestNodeDir(nodeDir)
	}
})

test('facade exports peer health query surface', async () => {
	const facade = await import('../../index.mjs')
	assert.equal(typeof facade.getPeerHealth, 'function')
	assert.equal(typeof facade.listPeerHealth, 'function')
	assert.equal(typeof facade.onPeerHealth, 'function')
})

test('startNode after init rejects conflicting options; setSignalingRuntimeConfig emits', async () => {
	const nodeDir = await mkTestNodeDir('p2p-edge-')
	try {
		resetAll()
		initNode({ nodeDir })
		await startNode()
		await assert.rejects(() => startNode({ nodeDir }), /ignored after initNode/)
		let saw = null
		const off = onNodeChange((event, payload) => { saw = { event, payload } })
		setSignalingRuntimeConfig({ channels: { nostr: { relay: ['wss://hot.example/'] } } })
		off()
		assert.equal(saw?.event, 'signaling-changed')
		assert.deepEqual(getSignalingRuntimeConfig().channels.nostr.relay, ['wss://hot.example/'])
		assert.equal(typeof getLinkRegistry().reloadDiscoveryRelays, 'function')
	}
	finally {
		resetAll()
		await teardownTestNodeDir(nodeDir)
	}
})

test('setSignalingRuntimeConfig merges channels preserving disabled/customized settings on partial update', async () => {
	const nodeDir = await mkTestNodeDir('p2p-edge-')
	try {
		resetAll()
		initNode({ nodeDir })
		setSignalingRuntimeConfig({ channels: { bt: false, webrtc: { trickleIceOff: true } } })
		setSignalingRuntimeConfig({ channels: { nostr: { relay: ['wss://hot.example/'] } } })
		const {channels} = getSignalingRuntimeConfig()
		assert.equal(channels.bt, false)
		assert.equal(channels.webrtc.trickleIceOff, true)
		assert.deepEqual(channels.nostr.relay, ['wss://hot.example/'])
		assert.notEqual(channels.lan, false)
	}
	finally {
		resetAll()
		await teardownTestNodeDir(nodeDir)
	}
})

test('ensureUserRoom default does not attach full wires', async () => {
	const nodeDir = await mkTestNodeDir('p2p-edge-')
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
		await teardownTestNodeDir(nodeDir)
	}
})

test('chunk attach reads live replicaUsername', async () => {
	const nodeDir = await mkTestNodeDir('p2p-edge-')
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
		await teardownTestNodeDir(nodeDir)
	}
})

test('registerNodeScopeWireHook fires on ensure and when wire already exists', async () => {
	const nodeDir = await mkTestNodeDir('p2p-edge-')
	try {
		resetAll()
		initNode({ nodeDir })
		/** @type {unknown[]} */
		const seen = []
		const unregister = registerNodeScopeWireHook((context, wire) => {
			seen.push({ when: 'before-ensure', username: context.replicaUsername, wire })
			wire.on('emoji_probe', () => { })
		})
		assert.equal(seen.length, 0)
		ensureNodeScope({ replicaUsername: 'alice' })
		assert.equal(seen.length, 1)
		assert.equal(seen[0].username, 'alice')
		assert.equal(seen[0].wire, getNodeScopeWire())
		assert.equal(hasNodeScopeAction('emoji_probe'), true)
		unregister()

		registerNodeScopeWireHook((context, wire) => {
			seen.push({ when: 'late', username: context.replicaUsername, wire })
		})
		assert.equal(seen.length, 2)
		assert.equal(seen[1].when, 'late')
		assert.equal(seen[1].wire, getNodeScopeWire())
	}
	finally {
		resetAll()
		await teardownTestNodeDir(nodeDir)
	}
})

test('lockReputationMax forces score to 1; unlock restores prior score', async () => {
	const nodeDir = await mkTestNodeDir('p2p-edge-')
	try {
		resetAll()
		initNode({ nodeDir })
		await setReputationTable({ byNodeHash: { [HASH_A]: { score: 0.2 } } })
		await lockReputationMax([HASH_A])
		assert.equal(loadReputation().byNodeHash[HASH_A].score, 1)
		assert.deepEqual(getReputationLocks(), [HASH_A])
		await unlockReputationMax([HASH_A])
		assert.deepEqual(getReputationLocks(), [])
		assert.equal(loadReputation().byNodeHash[HASH_A].score, 0.2)
	}
	finally {
		resetAll()
		await teardownTestNodeDir(nodeDir)
	}
})

test('rep_sync_req responds for allowlisted peer without writing caller table', async () => {
	const nodeDir = await mkTestNodeDir('p2p-edge-')
	try {
		resetAll()
		initNode({ nodeDir })
		await setReputationTable({ byNodeHash: { [HASH_A]: { score: 0.77 } } })
		setReputationExportAllowlist([HASH_B])
		attachReputationSyncWire()
		const wire = (await import('../../transport/node_scope/wire.mjs')).getNodeScopeWire()
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
		await teardownTestNodeDir(nodeDir)
	}
})

test('fetchPublicManifest returns null on bad input without hanging; cache is opt-in export', async () => {
	const miss = await (await import('../../files/manifest/fetch.mjs')).fetchPublicManifest({
		username: '',
		ownerEntityHash: '',
		logicalPath: '',
	})
	assert.equal(miss, null)
	assert.equal(typeof cachePublicManifest, 'function')
})
