import { test } from 'node:test'

import { buildSignedAdvert } from '../../link/handshake.mjs'
import { assert, assertEquals } from '../helpers/assert.mjs'
import { startFakeRelay } from '../helpers/fake_relay.mjs'
import { identity } from '../helpers/identity.mjs'

/**
 * 获取网络 rendezvous key。
 * @returns {Promise<string>} 网络 rendezvous key
 */
const networkRendezvousKey = async () => (await import('../../discovery/internal/signal_crypto.mjs')).networkRendezvousKey()

/**
 * 初始化 relay 测试状态。
 * @returns {Promise<object>} relay 模块
 */
async function setup() {
	const relays = await import('../../discovery/nostr/relays.mjs')
	let data = null
	relays.setRelayStorageIOForTests({
		/**
		 * 读取测试存储。
		 * @returns {object | null} 存储数据
		 */
		read: () => data,
		/**
		 *
		 * @param {object} value 存储数据
		 * @returns {void}
		 */
		write: value => { data = value }
	})
	relays.resetNostrRelaysForTests()
	relays.loadRelayPool()
	// 取消任何后台 probe 的真实网络副作用：仅保留在本地假 relay 上的 probe。
	relays.setNostrRelayDiscoveryEnabledForTests(false)
	return relays
}

/**
 * 构建加密 advert。
 * @param {Array<{ url: string, rttMs: number }>} relayPool relay pool
 * @param {string[]} listenRelays 监听 relay 列表
 * @returns {Promise<{ local: object, bytes: Uint8Array }>} 加密 advert
 */
async function buildEncryptedAdvert(relayPool, listenRelays) {
	const local = identity(31)
	const body = await buildSignedAdvert(await networkRendezvousKey(), Date.now(), {
		...local,
		nostrRelayPool: relayPool,
		listenNostrRelays: listenRelays,
	})
	const { encryptAdvertForScope } = await import('../../discovery/adverts.mjs')
	return { local, bytes: encryptAdvertForScope('network', local, body) }
}

test('acceptNostrAdvert stores peer listen/pool and absorbs peer relays', async () => {
	const relays = await setup()
	const { acceptNostrAdvert } = await import('../../discovery/nostr/index.mjs')
	const relayPool = [
		{ url: 'ws://127.0.0.1:1', rttMs: 30 },
		{ url: 'wss://peer-pool.example.com', rttMs: 40 },
	]
	const { local, bytes } = await buildEncryptedAdvert(relayPool, ['ws://127.0.0.1:1'])
	assertEquals(await acceptNostrAdvert(await networkRendezvousKey(), bytes), local.nodeHash)
	const route = relays.getPeerRoute(local.nodeHash)
	assertEquals(route.listenRelays, ['ws://127.0.0.1:1'])
	assertEquals(route.peerPool.length, 2, 'peer pool stored')
	const absorbed = relays.getPoolByUrl().get('ws://127.0.0.1:1')
	assert(absorbed, 'peer url absorbed into local pool')
	assertEquals(absorbed.source, 'peer')
	assertEquals(relays.getPoolByUrl().get('wss://peer-pool.example.com').source, 'peer')
})

test('peer route round-trips through persisted storage', async () => {
	const relays = await setup()
	const { acceptNostrAdvert, clearNostrVisibleNodes } = await import('../../discovery/nostr/index.mjs')
	clearNostrVisibleNodes()
	const relayPool = [{ url: 'wss://persist-peer.example.com', rttMs: 50 }]
	const { local, bytes } = await buildEncryptedAdvert(relayPool, ['wss://persist-peer.example.com'])
	await acceptNostrAdvert(await networkRendezvousKey(), bytes)
	relays.flushRelayStateNow()
	relays.loadRelayPool()
	const route = relays.getPeerRoute(local.nodeHash)
	assertEquals(route.listenRelays, ['wss://persist-peer.example.com'])
	assertEquals(route.peerPool[0].url, 'wss://persist-peer.example.com')
})

test('peer relay probe success upgrades stats on a live fake relay', async () => {
	const relay = await startFakeRelay()
	try {
		const relays = await setup()
		const { acceptNostrAdvert } = await import('../../discovery/nostr/index.mjs')
		const liveUrl = `ws://127.0.0.1:${relay.port}`
		const { bytes } = await buildEncryptedAdvert([{ url: liveUrl, rttMs: 10 }], [liveUrl])
		await acceptNostrAdvert(await networkRendezvousKey(), bytes)
		// 后台 probe 异步执行；等它落到池里（probe 结束前轮询）。
		for (let i = 0; i < 100; i++) {
			const entry = relays.getPoolByUrl().get(liveUrl)
			if (entry && entry.successCount > 0) break
			await new Promise(resolve => setTimeout(resolve, 25))
		}
		const entry = relays.getPoolByUrl().get(liveUrl)
		assert(entry.successCount >= 1, `probe success recorded (got ${entry.successCount})`)
		assert(entry.rttMs != null, 'rtt recorded')
		assertEquals(entry.source, 'peer', 'source stays peer')
	}
	finally {
		await relay.stop()
	}
})
