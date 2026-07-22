import { strict as assert } from 'node:assert'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { entityHashFromRecoveryPubKeyHex } from '../../core/entity_id.mjs'
import { keyPairFromSeed, pubKeyHash } from '../../crypto/crypto.mjs'
import { encryptSignalPacket } from '../../discovery/internal/signal_crypto.mjs'
import { clearLanPeerHints, getLanPeerHint } from '../../discovery/lan_peer_hints.mjs'
import { buildFileManifestFromEnc, encryptPlaintextToParts } from '../../files/assemble.mjs'
import { loadFileManifest } from '../../files/evfs.mjs'
import { publicTransferKeyDescriptor } from '../../files/manifest.mjs'
import { cachePublicManifest } from '../../files/manifest_fetch.mjs'
import { attachPublicManifestSig } from '../../files/public_manifest.mjs'
import { defaultNodeDir, resolveNodeDir } from '../../infra/default_node_dir.mjs'
import {
	consumeOverlayRateToken,
	getInfraPriority,
	isInfraRunning,
	setInfraPriority,
	startInfra,
	stopInfra,
} from '../../infra/service.mjs'
import { buildSignedAdvert } from '../../link/handshake.mjs'
import { initNode, resetNodeForTests } from '../../node/instance.mjs'
import { loadNetwork, replaceNetworkPeerPools } from '../../node/network.mjs'
import {
	getReputationTable,
	pullReputationFromNode,
	resetReputationSyncForTests,
	setReputationTable,
	setTrustSyncDonors,
	attachReputationSyncWire,
} from '../../node/reputation_sync.mjs'
import { getRoutingProfile, setRoutingProfile } from '../../node/routing_profile.mjs'
import { applyAdvertPeerHints, ingestSignedAdvert } from '../../transport/advert_ingest.mjs'
import {
	configureLinkRegistry,
	getLinkRegistry,
	resetLinkRegistryForTests,
} from '../../transport/link_registry.mjs'
import {
	attachNodeScopeMailbox,
	attachNodeScopePart,
	attachUserRoomDefaultWires,
	countNodeScopeActionHandlers,
	dispatchNodeScopeAction,
	hasNodeScopeAction,
	stopNodeScopeRuntime,
} from '../../transport/node_scope.mjs'

const HASH_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const HASH_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

/**
 * @returns {Promise<string>} 临时 nodeDir 路径
 */
async function tmpNodeDir() {
	return mkdtemp(path.join(os.tmpdir(), 'p2p-plan-'))
}

/**
 * @returns {void} 重置测试用节点 / registry / sync / scope 状态
 */
function resetAll() {
	resetNodeForTests()
	resetLinkRegistryForTests()
	resetReputationSyncForTests()
	stopNodeScopeRuntime()
	clearLanPeerHints()
}

test('defaultNodeDir returns absolute path', () => {
	const dir = defaultNodeDir()
	assert.ok(path.isAbsolute(dir))
	assert.ok(dir.includes('fount-p2p'))
})

test('resolveNodeDir honors override', () => {
	assert.equal(resolveNodeDir('/tmp/foo'), path.resolve('/tmp/foo'))
})

test('overlay rate token bucket bursts then refills at perMin', () => {
	const buckets = new Map()
	const limits = { perMin: 60, burst: 5 }
	const sender = HASH_A
	const t0 = 1_000_000
	for (let i = 0; i < 5; i++)
		assert.equal(consumeOverlayRateToken(buckets, sender, t0 + i, limits), true)
	assert.equal(consumeOverlayRateToken(buckets, sender, t0 + 5, limits), false)
	assert.equal(consumeOverlayRateToken(buckets, sender, t0 + 1005, limits), true)
})

test('stopNodeScopeRuntime disposes rep_sync handlers', async () => {
	const nodeDir = await tmpNodeDir()
	try {
		resetAll()
		initNode({ nodeDir })
		attachReputationSyncWire()
		assert.equal(hasNodeScopeAction('rep_sync_req'), true)
		stopNodeScopeRuntime()
		assert.equal(hasNodeScopeAction('rep_sync_req'), false)
		const dispose = attachReputationSyncWire()
		assert.equal(hasNodeScopeAction('rep_sync_req'), true)
		dispose()
		assert.equal(hasNodeScopeAction('rep_sync_req'), false)
	}
	finally {
		resetAll()
		await rm(nodeDir, { recursive: true, force: true })
	}
})

test('lean attach: mailbox only, dispose removes handlers', async () => {
	const nodeDir = await tmpNodeDir()
	try {
		resetAll()
		initNode({ nodeDir })
		const disposeMailbox = attachNodeScopeMailbox()
		assert.equal(hasNodeScopeAction('mailbox_put'), true)
		assert.equal(hasNodeScopeAction('part_timeline_put'), false)
		const disposePart = attachNodeScopePart()
		assert.equal(hasNodeScopeAction('part_timeline_put'), true)
		disposeMailbox()
		assert.equal(hasNodeScopeAction('mailbox_put'), false)
		assert.equal(hasNodeScopeAction('part_timeline_put'), true)
		disposePart()
		assert.equal(hasNodeScopeAction('part_timeline_put'), false)
	}
	finally {
		resetAll()
		await rm(nodeDir, { recursive: true, force: true })
	}
})

test('configureLinkRegistry before create; setMaxActive/setIceServers; second configure throws', async () => {
	const nodeDir = await tmpNodeDir()
	try {
		resetAll()
		configureLinkRegistry({ maxActive: 12 })
		initNode({ nodeDir })
		const registry = getLinkRegistry()
		assert.equal(registry.getMaxActive(), 12)
		await registry.setMaxActive(40)
		assert.equal(registry.getMaxActive(), 40)
		const ice = [{ urls: 'stun:stun.test.example:3478' }]
		registry.setIceServers(ice)
		assert.deepEqual(registry.getIceServers(), ice)
		registry.setIceServers([])
		assert.ok(registry.getIceServers()?.length)
		registry.ensureOverlayRouter()
		assert.throws(() => configureLinkRegistry({ maxActive: 8 }), /before getLinkRegistry/)
	}
	finally {
		resetAll()
		await rm(nodeDir, { recursive: true, force: true })
	}
})

test('pull≠set: pull failure does not write; setReputationTable writes', async () => {
	const nodeDir = await tmpNodeDir()
	try {
		resetAll()
		initNode({ nodeDir })
		const beforeKeys = Object.keys(getReputationTable().byNodeHash || {})
		setTrustSyncDonors([HASH_A])
		await assert.rejects(() => pullReputationFromNode(HASH_A), /rep_sync/)
		assert.deepEqual(Object.keys(getReputationTable().byNodeHash || {}), beforeKeys)
		await setReputationTable({ byNodeHash: { [HASH_A]: { score: 0.9 } } })
		assert.equal(getReputationTable().byNodeHash[HASH_A].score, 0.9)
	}
	finally {
		resetAll()
		await rm(nodeDir, { recursive: true, force: true })
	}
})

test('pull success returns JSON without writing local table', async () => {
	const nodeDir = await tmpNodeDir()
	try {
		resetAll()
		configureLinkRegistry({ autoRegisterDiscoveryProviders: false, autoRegisterLinkProviders: false })
		initNode({ nodeDir })
		const registry = getLinkRegistry()
		const originalSend = registry.sendToNodeLink
		/**
		 * @param {string} _hash - 目标 nodeHash（测试中忽略）
		 * @param {{ payload: { requestId: string } }} envelope - 出站 envelope
		 * @returns {Promise<boolean>} 始终视为发送成功
		 */
		registry.sendToNodeLink = async (_hash, envelope) => {
			queueMicrotask(() => {
				dispatchNodeScopeAction('rep_sync_res', {
					requestId: envelope.payload.requestId,
					byNodeHash: { [HASH_B]: { score: 0.55 } },
				}, HASH_A)
			})
			return true
		}
		setTrustSyncDonors([HASH_A])
		const before = structuredClone(getReputationTable())
		const pulled = await pullReputationFromNode(HASH_A)
		assert.equal(pulled.byNodeHash[HASH_B].score, 0.55)
		assert.deepEqual(getReputationTable(), before)
		registry.sendToNodeLink = originalSend
	}
	finally {
		resetAll()
		await rm(nodeDir, { recursive: true, force: true })
	}
})

test('valid ingestSignedAdvert verifies without writing peer hints', async () => {
	clearLanPeerHints()
	const seed = Buffer.alloc(32, 5)
	const { publicKey, secretKey } = keyPairFromSeed(seed)
	const nodeHash = pubKeyHash(publicKey)
	const rendezvousKey = `rdv:${nodeHash}`
	const advert = await buildSignedAdvert(rendezvousKey, Date.now(), {
		secretKey,
		nodeHash,
		nodePubKey: Buffer.from(publicKey).toString('hex'),
		tcpPort: 19091,
	})
	const bytes = encryptSignalPacket(rendezvousKey, { type: 'advert', body: advert })
	const ingested = await ingestSignedAdvert(rendezvousKey, bytes, { address: '10.0.0.8' })
	assert.equal(ingested?.verifiedNodeHash, nodeHash)
	assert.equal(getLanPeerHint(nodeHash), null)
	applyAdvertPeerHints(ingested.verifiedNodeHash, ingested.body, { address: '10.0.0.8' })
	assert.deepEqual(getLanPeerHint(nodeHash), { host: '10.0.0.8', port: 19091 })
})

test('ingestSignedAdvert does not apply peer hints without applyAdvertPeerHints', async () => {
	clearLanPeerHints()
	const ingested = await ingestSignedAdvert('rdv', new Uint8Array([1, 2, 3]))
	assert.equal(ingested, null)
	assert.equal(getLanPeerHint(HASH_B), null)
	applyAdvertPeerHints(HASH_B, { tcpPort: 19090 }, { address: '10.0.0.9' })
	assert.deepEqual(getLanPeerHint(HASH_B), { host: '10.0.0.9', port: 19090 })
})

test('infra start/stop restores maxActive and removes only mailbox', async () => {
	const nodeDir = await tmpNodeDir()
	try {
		resetAll()
		configureLinkRegistry({ maxActive: 16 })
		initNode({ nodeDir })
		const registry = getLinkRegistry()
		assert.equal(registry.getMaxActive(), 16)
		const disposePart = attachNodeScopePart()
		assert.equal(hasNodeScopeAction('part_timeline_put'), true)
		await startInfra({ logger: null, maxActive: 48 })
		assert.equal(isInfraRunning(), true)
		assert.equal(registry.getMaxActive(), 48)
		assert.equal(hasNodeScopeAction('mailbox_put'), true)
		setInfraPriority({ useLocalReputation: true })
		assert.equal(getInfraPriority().useLocalReputation, true)
		await setReputationTable({ byNodeHash: { [HASH_A]: { score: 0.8 } } })
		assert.ok(registry.getPriorityWeight(HASH_A) > 0)
		await stopInfra()
		assert.equal(isInfraRunning(), false)
		assert.equal(getInfraPriority().useLocalReputation, false)
		assert.equal(registry.getPriorityWeight(HASH_A), 0)
		assert.equal(registry.getMaxActive(), 16)
		assert.equal(hasNodeScopeAction('mailbox_put'), false)
		assert.equal(hasNodeScopeAction('part_timeline_put'), true)
		await startInfra({ logger: null })
		assert.equal(getInfraPriority().useLocalReputation, false)
		assert.equal(registry.getPriorityWeight(HASH_A), 0)
		await stopInfra()
		disposePart()
	}
	finally {
		await stopInfra().catch(() => { })
		resetAll()
		await rm(nodeDir, { recursive: true, force: true })
	}
})

test('infra + default wires share one mailbox handler; stopInfra keeps user mailbox', async () => {
	const nodeDir = await tmpNodeDir()
	try {
		resetAll()
		configureLinkRegistry({ autoRegisterDiscoveryProviders: false, autoRegisterLinkProviders: false })
		initNode({ nodeDir })
		await startInfra({ logger: null })
		assert.equal(countNodeScopeActionHandlers('mailbox_put'), 1)
		const disposeDefaults = attachUserRoomDefaultWires({ replicaUsername: 'alice' })
		assert.equal(countNodeScopeActionHandlers('mailbox_put'), 1)
		assert.equal(hasNodeScopeAction('part_timeline_put'), true)
		await stopInfra()
		assert.equal(hasNodeScopeAction('mailbox_put'), true)
		assert.equal(countNodeScopeActionHandlers('mailbox_put'), 1)
		disposeDefaults()
		assert.equal(hasNodeScopeAction('mailbox_put'), false)
		assert.equal(hasNodeScopeAction('part_timeline_put'), false)
	}
	finally {
		await stopInfra().catch(() => { })
		resetAll()
		await rm(nodeDir, { recursive: true, force: true })
	}
})

test('priority weight re-reads reputation table after setReputationTable', async () => {
	const nodeDir = await tmpNodeDir()
	try {
		resetAll()
		initNode({ nodeDir })
		const registry = getLinkRegistry()
		await setReputationTable({ byNodeHash: { [HASH_A]: { score: 0.5 } } })
		setInfraPriority({ useLocalReputation: true })
		assert.equal(registry.getPriorityWeight(HASH_A), 500)
		await setReputationTable({ byNodeHash: { [HASH_A]: { score: 0.8 } } })
		assert.equal(registry.getPriorityWeight(HASH_A), 800)
		setInfraPriority({ useLocalReputation: false })
		assert.equal(registry.getPriorityWeight(HASH_A), 0)
	}
	finally {
		resetAll()
		await rm(nodeDir, { recursive: true, force: true })
	}
})

test('cachePublicManifest writes remote public manifest to store', async () => {
	const nodeDir = await tmpNodeDir()
	try {
		resetAll()
		initNode({ nodeDir })
		const keys = keyPairFromSeed(Buffer.from('cache-public-manifest-seed----'))
		const pubKeyHex = Buffer.from(keys.publicKey).toString('hex')
		const owner = entityHashFromRecoveryPubKeyHex(HASH_B, pubKeyHex)
		const plaintext = Buffer.from('hello-cache')
		const enc = encryptPlaintextToParts(plaintext, 'convergent')
		const base = buildFileManifestFromEnc({
			ownerEntityHash: owner,
			logicalPath: 'profile.json',
			plaintext,
			name: 'profile.json',
			mimeType: 'application/json',
			ceMode: 'convergent',
			transferKeyDescriptor: publicTransferKeyDescriptor(),
		}, enc)
		const signed = await attachPublicManifestSig(base, 1_700_000_000_000, keys.secretKey, pubKeyHex)
		assert.equal(await loadFileManifest(owner, 'profile.json'), null)
		await cachePublicManifest(owner, 'profile.json', signed)
		const cached = await loadFileManifest(owner, 'profile.json')
		assert.equal(cached?.logicalPath, 'profile.json')
		assert.equal(cached?.meta?.publicSig?.publishedAt, 1_700_000_000_000)
	}
	finally {
		resetAll()
		await rm(nodeDir, { recursive: true, force: true })
	}
})

test('cli --help prints usage', async () => {
	const cli = path.join(process.cwd(), 'infra', 'cli.mjs')
	const out = await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [cli, '--help'], { cwd: process.cwd() })
		let stdout = ''
		child.stdout.on('data', chunk => { stdout += chunk })
		child.on('error', reject)
		child.on('close', code => resolve({ code, stdout }))
	})
	assert.equal(out.code, 0)
	assert.match(out.stdout, /fount-p2p/)
	assert.match(out.stdout, /--node-dir/)
})

test('setRoutingProfile and replaceNetworkPeerPools', async () => {
	const nodeDir = await tmpNodeDir()
	try {
		resetAll()
		initNode({ nodeDir })
		assert.equal(getRoutingProfile(), 'default')
		setRoutingProfile('low')
		assert.equal(getRoutingProfile(), 'low')
		setRoutingProfile('default')
		replaceNetworkPeerPools({ trustedPeers: [HASH_A], explorePeers: [HASH_B] })
		const net = loadNetwork()
		assert.deepEqual(net.trustedPeers, [HASH_A])
		assert.deepEqual(net.explorePeers, [HASH_B])
		replaceNetworkPeerPools({ trustedPeers: [], explorePeers: [] })
		assert.deepEqual(loadNetwork().trustedPeers, [])
	}
	finally {
		resetAll()
		await rm(nodeDir, { recursive: true, force: true })
	}
})
