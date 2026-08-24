import { performance } from 'node:perf_hooks'
import { test } from 'node:test'

import { clearDiscoveryProviders } from '../../discovery/index.mjs'
import { createNostrDiscoveryProvider, DEFAULT_RELAY_URLS, NOSTR_CONNECT_TIMEOUT_MS } from '../../discovery/nostr.mjs'
import { clearLinkProviders } from '../../link/providers/index.mjs'
import { createLinkRegistry } from '../../transport/link_registry.mjs'
import { assert, assertEquals } from '../helpers/assert.mjs'
import { identity } from '../helpers/identity.mjs'
import { initTestP2pNode } from '../helpers/node.mjs'
import { mkTestNodeDir, teardownTestNodeDir } from '../helpers/node_dir_leak.mjs'

/** ensureRuntime 仅注册 + 调度后台暖机，不得等 listen / 公网 */
const COLD_STARTUP_BUDGET_MS = 50
/** 同进程再次 ensureRuntime（模块已热；含调度方差） */
const WARM_STARTUP_BUDGET_MS = 5

/**
 * @param {string} dir nodeDir
 * @param {ReturnType<typeof identity>} localIdentity 本地身份
 * @returns {ReturnType<typeof createLinkRegistry>} registry
 */
function openRegistry(dir, localIdentity) {
	initTestP2pNode({ nodeDir: dir })
	return createLinkRegistry({
		localIdentity,
		autoRegisterDiscoveryProviders: true,
		autoRegisterLinkProviders: true,
		meshKeepalive: false,
	})
}

test('ensureRuntime cold ≤50ms, warm ≤20ms; listening is background', async () => {
	clearLinkProviders()
	clearDiscoveryProviders()
	const nodeDir = await mkTestNodeDir('fount-p2p-startup-')
	try {
		const cold = openRegistry(nodeDir, identity(91))
		const tCold = performance.now()
		await cold.ensureRuntime()
		const coldMs = performance.now() - tCold
		assert(coldMs < COLD_STARTUP_BUDGET_MS, `cold ensureRuntime ${coldMs.toFixed(1)}ms >= ${COLD_STARTUP_BUDGET_MS}ms`)

		assertEquals(cold.listLinks().length, 0)
		assertEquals(cold.getLink(identity(92).nodeHash), null)
		const unsub = cold.subscribeScope('node', () => { })
		assertEquals(typeof unsub, 'function')
		unsub()

		await cold.whenListening()
		assertEquals(typeof cold.lanTcpPort(), 'number')
		const advert = await cold.buildLocalAdvert()
		assertEquals(advert.nodeHash, identity(91).nodeHash)
		assertEquals(advert.tcpPort, cold.lanTcpPort())
		await cold.shutdown()
		clearLinkProviders()
		clearDiscoveryProviders()

		const warm = openRegistry(nodeDir, identity(93))
		const tWarm = performance.now()
		await warm.ensureRuntime()
		const warmMs = performance.now() - tWarm
		assert(warmMs < WARM_STARTUP_BUDGET_MS, `warm ensureRuntime ${warmMs.toFixed(1)}ms >= ${WARM_STARTUP_BUDGET_MS}ms`)
		await warm.shutdown()
	}
	finally {
		clearLinkProviders()
		clearDiscoveryProviders()
		await teardownTestNodeDir(nodeDir)
	}
})

test('nostr list/connect/signal return without waiting for relays', async () => {
	const provider = createNostrDiscoveryProvider({ relayUrls: [...DEFAULT_RELAY_URLS] })
	const local = identity(1)
	const remote = identity(2)
	const t0 = performance.now()
	const hashes = await provider.listVisibleNodeHashes({ limit: 8 })
	const stopSig = await provider.listenNodeSignals(local.nodeHash, () => { })
	const stopAdv = await provider.startPresence(async () => ({
		nodeHash: local.nodeHash,
		advertBody: { nodeHash: local.nodeHash, ts: Date.now(), sig: '0'.repeat(128), nodePubKey: local.nodePubKey },
	}))
	const connected = await provider.connectToNode(remote.nodeHash)
	const elapsed = performance.now() - t0
	stopSig()
	stopAdv()
	assertEquals(Array.isArray(hashes), true)
	assertEquals(connected, true)
	assert(elapsed < NOSTR_CONNECT_TIMEOUT_MS / 4, `nostr progressive start ${elapsed.toFixed(1)}ms`)
})

test('explicit empty relayUrls is not refilled with defaults', async () => {
	const provider = createNostrDiscoveryProvider({ relayUrls: [] })
	const stop = await provider.listenNodeSignals(identity(3).nodeHash, () => { })
	stop()
	await assert.rejects(
		() => provider.sendNodeSignal(identity(4).nodeHash, new Uint8Array([1])),
		/no relay/,
	)
})
