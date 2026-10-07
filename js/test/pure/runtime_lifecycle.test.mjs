import { test } from 'node:test'

import { clearDiscoveryProviders, decryptNodeSignalPacket } from '../../discovery/index.mjs'
import { createNostrDiscoveryProvider } from '../../discovery/nostr/index.mjs'
import { clearLinkProviders, listLinkProviders, registerLinkProvider } from '../../link/providers/index.mjs'
import { setSignalingRuntimeConfig } from '../../node/instance.mjs'
import { createLinkRegistry } from '../../transport/link_registry.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { startFakeRelay } from '../helpers/fake_relay.mjs'
import { identity } from '../helpers/identity.mjs'
import { initTestP2pNode } from '../helpers/node.mjs'
import { mkTestNodeDir, teardownTestNodeDir } from '../helpers/node_dir_leak.mjs'
import { waitFor } from '../live/helpers.mjs'

/**
 * 在临时 node 目录上跑一轮 registry 生命周期。
 * @param {ReturnType<typeof identity>} local 本地身份
 * @param {(registry: ReturnType<typeof createLinkRegistry>) => Promise<void>} run 断言回调
 * @returns {Promise<void>}
 */
async function withRuntime(local, run) {
	const nodeDir = await mkTestNodeDir('fount-p2p-runtime-lifecycle-')
	try {
		initTestP2pNode({ nodeDir })
		const registry = createLinkRegistry({
			localIdentity: local,
			autoRegisterDiscoveryProviders: true,
			autoRegisterLinkProviders: true,
			meshKeepalive: false,
		})
		try {
			await run(registry)
		}
		finally {
			await registry.shutdown()
		}
	}
	finally {
		clearLinkProviders()
		clearDiscoveryProviders()
		await teardownTestNodeDir(nodeDir)
	}
}

/**
 * nostr-only 通道配置。
 * @param {string} relayUrl relay URL
 * @returns {object} 通道配置
 */
function nostrOnly(relayUrl) {
	return { nostr: { relay: [relayUrl] }, lan: false, bt: false, webrtc: false }
}

/**
 * 只记录 ensureListening 的假 nostr provider（无需真实传输）。
 * id 带 `:probe` 后缀：不会被真实 nostr provider 的注册所取代，避免命中它已登记的 stop 函数。
 * @returns {{ provider: object, listenCalls: () => number }} 记录探针
 */
function createListeningProbe() {
	/** @type {boolean} */
	let listening = false
	let listenCalls = 0
	const provider = {
		id: 'nostr:probe',
		level: Number.NEGATIVE_INFINITY,
		caps: { needsOfferAnswer: false, needsDiscoverySignal: false, probe: 'sync' },
		/** @returns {boolean} 有中继即可用 */
		isAvailable: () => true,
		/** @returns {boolean} 有中继即可达 */
		canReach: () => true,
		/**
		 * @returns {() => void} 停止监听
		 */
		ensureListening() {
			listenCalls++
			listening = true
			return () => { listening = false }
		},
		/** @returns {null} 不建链 */
		dial() { return null },
		/**
		 * @returns {boolean} 当前是否已挂上监听
		 */
		isListening() { return listening },
	}
	return { provider, listenCalls: () => listenCalls }
}

test('reload attaches listening to every enabled link provider, not just the owned lan/bt ones', async () => {
	const self = identity(102)
	const relay = await startFakeRelay(() => true, { broadcast: true })
	const relayUrl = `ws://127.0.0.1:${relay.port}`
	try {
		await withRuntime(self, async registry => {
			setSignalingRuntimeConfig({ channels: nostrOnly(relayUrl) })
			await registry.ensureRuntime()
			await relay.waitReqs(1)

			// 真实 nostr provider 不暴露监听状态，故用一个记录探针独立证明 reload 会补监听。
			const probe = createListeningProbe()
			registerLinkProvider(probe.provider)
			assertEquals(probe.provider.isListening(), false)
			await registry.reloadDiscoveryRelays()
			assertEquals(probe.listenCalls(), 1, 'reload must call ensureListening on the registered nostr provider')
			assertEquals(probe.provider.isListening(), true)
		})
	}
	finally {
		clearLinkProviders()
		await relay.stop()
	}
})

test('network advert advertises configured Nostr listen relays', async () => {
	const self = identity(105)
	const nodeDir = await mkTestNodeDir('fount-p2p-runtime-advert-relays-')
	const relayUrls = ['wss://configured-a.example.com', 'wss://configured-b.example.com']
	try {
		initTestP2pNode({ nodeDir })
		setSignalingRuntimeConfig({
			channels: { nostr: { relay: relayUrls }, lan: false, bt: false, webrtc: false },
		})
		const registry = createLinkRegistry({
			localIdentity: self,
			autoRegisterDiscoveryProviders: false,
			autoRegisterLinkProviders: false,
			meshKeepalive: false,
		})
		try {
			await registry.ensureRuntime()
			const advert = await registry.buildLocalAdvert('network')
			assertEquals(advert.listenNostrRelays, relayUrls)
		}
		finally {
			await registry.shutdown()
		}
	}
	finally {
		clearLinkProviders()
		clearDiscoveryProviders()
		await teardownTestNodeDir(nodeDir)
	}
})

test('disable then re-enable nostr keeps the newly registered provider answering inbound link-open', async () => {
	clearLinkProviders()
	clearDiscoveryProviders()
	const self = identity(102)
	const peer = identity(101)
	const relay = await startFakeRelay(() => true, { broadcast: true })
	const relayUrl = `ws://127.0.0.1:${relay.port}`
	// 观察「接受方」身份：registry 处理入站 open 后会把 hello（`c`）发往 peer.nodeHash 的 rendezvous。
	const observer = createNostrDiscoveryProvider({ relayUrls: [relayUrl], localNodeHash: peer.nodeHash })
	/** @type {string[]} */
	const seenPackets = []
	let stopObserverSignals = null
	try {
		stopObserverSignals = await observer.listenNodeSignals(peer.nodeHash, bytes => {
			const packet = decryptNodeSignalPacket(peer.nodeHash, bytes)
			if (!packet) return
			seenPackets.push(packet.type === 'link' ? `link:${packet.op}` : String(packet.type))
		})
		await withRuntime(self, async registry => {
			setSignalingRuntimeConfig({ channels: nostrOnly(relayUrl) })
			await registry.ensureRuntime()
			await relay.waitReqs(1)
			const findNostrLink = () => listLinkProviders().find(provider => provider.id.split(':')[0] === 'nostr')
			assertEquals(!!findNostrLink(), true, 'nostr link provider is registered')

			// 基线：provider 必须已挂上监听（否则入站 open 会被静默丢弃）。
			await findNostrLink().deliverPacket({
				type: 'link',
				op: 'open',
				from: peer.nodeHash,
				linkId: 'a'.repeat(64),
			})
			await waitFor(() => seenPackets.includes('link:c'), 5_000)
			// 只数 hello：入站 open 的应答链路随后还会被对端/健康探测关掉，末包位置不可当作判断依据。
			const baselineHellos = seenPackets.filter(packet => packet === 'link:c').length

			// 关掉 nostr 再打开：registry 会在 reconcile 时注册一个全新的 provider 实例。
			setSignalingRuntimeConfig({ channels: { nostr: false, lan: false, bt: false, webrtc: false } })
			await waitFor(() => !findNostrLink(), 5_000)
			setSignalingRuntimeConfig({ channels: nostrOnly(relayUrl) })
			await waitFor(() => !!findNostrLink(), 5_000)
			await registry.ensureRuntime()
			// 等重启后的 discovery 订阅重新出现在 relay 上，确保 reload 那一轮已经跑完。
			await waitFor(() => relay.reqCount() >= 2, 5_000)

			await findNostrLink().deliverPacket({
				type: 'link',
				op: 'open',
				from: peer.nodeHash,
				linkId: 'b'.repeat(64),
			})
			await waitFor(() => seenPackets.filter(packet => packet === 'link:c').length > baselineHellos, 5_000)
			assertEquals(seenPackets.filter(packet => packet === 'link:c').length, baselineHellos + 1, 'the restarted provider answers the second inbound link-open with one hello')
		})
	}
	finally {
		stopObserverSignals?.()
		observer.dispose?.()
		clearLinkProviders()
		clearDiscoveryProviders()
		await relay.stop()
	}
})

test('registry restarts peer health tracking after shutdown and re-init', async () => {
	clearLinkProviders()
	const self = identity(103)
	const peer = identity(104)
	const nodeDir = await mkTestNodeDir('fount-p2p-runtime-peerhealth-')
	try {
		initTestP2pNode({ nodeDir })
		const fakeLink = {
			providerId: 'mock',
			level: 50,
			initiator: true,
			/** @returns {Promise<void>} */
			async close() { },
			/** @returns {() => void} */
			onEnvelope() { return () => { } },
			/** @returns {() => void} */
			onDown() { return () => { } },
			/** @returns {() => void} */
			onRtt() { return () => { } },
			/** @returns {{ rttMs: number }} */
			stats() { return { rttMs: 5 } },
		}
		const unregister = registerLinkProvider({
			id: 'zz-mock-dialer',
			level: 90,
			caps: { needsOfferAnswer: false, needsDiscoverySignal: false, probe: 'sync' },
			/** @returns {boolean} 可用 */
			isAvailable: () => true,
			/** @returns {boolean} 可到达 */
			canReach: () => true,
			/** @returns {Promise<object>} 直接返回假链路 */
			async dial() { return fakeLink },
		})
		const registry = createLinkRegistry({
			localIdentity: self,
			autoRegisterDiscoveryProviders: false,
			autoRegisterLinkProviders: false,
			meshKeepalive: false,
		})
		try {
			await registry.ensureRuntime()
			await registry.ensureLinkToNode(peer.nodeHash)
			assertEquals(registry.getPeerHealth(peer.nodeHash)?.connected, true)
			assertEquals(registry.getPeerHealth(peer.nodeHash)?.source, 'mock')
			await registry.shutdown()
			// 重启运行时后必须恢复追踪，否则 getPeerHealth / listPeerHealth 永久为空（fount-p2p#38）。
			await registry.ensureRuntime()
			await registry.ensureLinkToNode(peer.nodeHash)
			assertEquals(registry.getPeerHealth(peer.nodeHash)?.connected, true)
			assertEquals(registry.listPeerHealth().length, 1)
		}
		finally {
			unregister()
			await registry.shutdown()
		}
	}
	finally {
		clearLinkProviders()
		await teardownTestNodeDir(nodeDir)
	}
})
