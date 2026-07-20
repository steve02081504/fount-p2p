import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { test } from 'node:test'

import { clearDiscoveryProviders } from '../../discovery/index.mjs'
import { createNostrDiscoveryProvider, DEFAULT_RELAY_URLS, NOSTR_CONNECT_TIMEOUT_MS } from '../../discovery/nostr.mjs'
import { clearLinkProviders } from '../../link/providers/index.mjs'
import { createLinkRegistry } from '../../transport/link_registry.mjs'
import { assert, assertEquals } from '../helpers/assert.mjs'
import { identity } from '../helpers/identity.mjs'
import { initTestP2pNode } from '../helpers/node.mjs'

/** ensureRuntime 仅注册 + 调度后台暖机，不得等 listen / 公网 */
const COLD_STARTUP_BUDGET_MS = 50
/** 同进程再次 ensureRuntime（模块已热） */
const WARM_STARTUP_BUDGET_MS = 5

/**
 * @param {string} dir nodeDir
 * @param {ReturnType<typeof identity>} localIdentity 本地身份
 * @returns {ReturnType<typeof createLinkRegistry>} registry
 */
function openRegistry(dir, localIdentity) {
	// 与生产相同：默认公网 nostr + mdns（无 relayOverride）。
	initTestP2pNode({ nodeDir: dir })
	return createLinkRegistry({
		localIdentity,
		autoRegisterDiscoveryProviders: true,
		autoRegisterLinkProviders: true,
	})
}

test('ensureRuntime cold ≤50ms, warm ≤5ms; listening is background', async () => {
	clearLinkProviders()
	clearDiscoveryProviders()
	const dir = await mkdtemp(join(tmpdir(), 'fount-p2p-startup-'))
	try {
		await mkdir(dir, { recursive: true })

		const cold = openRegistry(dir, identity(91))
		const tCold = performance.now()
		await cold.ensureRuntime()
		const coldMs = performance.now() - tCold
		assert(coldMs < COLD_STARTUP_BUDGET_MS, `cold ensureRuntime ${coldMs.toFixed(1)}ms >= ${COLD_STARTUP_BUDGET_MS}ms`)

		// 返回时端口可能尚未落定；shell 不应读 tcpPort
		assertEquals(cold.listLinks().length, 0)
		assertEquals(cold.getLink(identity(92).nodeHash), null)
		const unsub = cold.subscribeScope('node', () => { })
		assertEquals(typeof unsub, 'function')
		unsub()

		await cold.whenListening()
		assertEquals(typeof cold.lanTcpPort(), 'number')
		const advert = await cold.buildLocalAdvert('startup-topic')
		assertEquals(advert.nodeHash, identity(91).nodeHash)
		assertEquals(advert.tcpPort, cold.lanTcpPort())
		await cold.shutdown()
		clearLinkProviders()
		clearDiscoveryProviders()

		const warm = openRegistry(dir, identity(93))
		const tWarm = performance.now()
		await warm.ensureRuntime()
		const warmMs = performance.now() - tWarm
		assert(warmMs < WARM_STARTUP_BUDGET_MS, `warm ensureRuntime ${warmMs.toFixed(1)}ms >= ${WARM_STARTUP_BUDGET_MS}ms`)
		await warm.shutdown()
	}
	finally {
		clearLinkProviders()
		clearDiscoveryProviders()
		await rm(dir, { recursive: true, force: true })
	}
})

test('nostr subscribe/onSignal/advertise return without waiting for relays', async () => {
	const provider = createNostrDiscoveryProvider({ relayUrls: [...DEFAULT_RELAY_URLS] })
	const t0 = performance.now()
	const stopSub = await provider.subscribe('topic-a', () => { })
	const stopSig = await provider.onSignal('topic-a', () => { })
	const stopAdv = await provider.advertise('topic-a', new Uint8Array([1, 2, 3]))
	const elapsed = performance.now() - t0
	stopSub()
	stopSig()
	stopAdv()
	// 须远小于单中继连接超时，证明未 await 首连
	assert(elapsed < NOSTR_CONNECT_TIMEOUT_MS / 4, `nostr progressive start ${elapsed.toFixed(1)}ms (timeout=${NOSTR_CONNECT_TIMEOUT_MS})`)
})

test('explicit empty relayUrls is not refilled with defaults', async () => {
	const provider = createNostrDiscoveryProvider({ relayUrls: [] })
	const stop = await provider.subscribe('topic-empty', () => { })
	stop()
	await assert.rejects(
		() => provider.sendSignal('topic-empty', 'peer', new Uint8Array([1])),
		/no relay/,
	)
})
