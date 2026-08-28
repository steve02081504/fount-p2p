import { test } from 'node:test'

import { clearDiscoveryProviders, decryptNodeSignalPacket, registerDiscoveryProvider } from '../../discovery/index.mjs'
import { clearLanPeerHints, noteLanPeerHint } from '../../discovery/lan_peer_hints.mjs'
import { createNostrDiscoveryProvider } from '../../discovery/nostr/index.mjs'
import { clearLinkProviders } from '../../link/providers/index.mjs'
import { createLanTcpLinkProvider } from '../../link/providers/lan_tcp.mjs'
import { createNostrLinkProvider } from '../../link/providers/nostr/index.mjs'
import { createOverlayRouter } from '../../overlay/index.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { startFakeRelay } from '../helpers/fake_relay.mjs'

import { identity, waitFor } from './helpers.mjs'

/**
 * 按 link 路由的轻量 mesh 节点（registry 形状子集，供 overlay router 使用）。
 * @param {{ nodeHash: string, nodePubKey: string, secretKey: Uint8Array }} localIdentity 本地身份
 * @returns {object} mesh 节点
 */
function createMeshNode(localIdentity) {
	/** @type {Map<string, object>} */
	const links = new Map()
	/** @type {Map<string, Set<Function>>} */
	const scopeListeners = new Map()
	return {
		localIdentity,
		/**
		 * 登记一条到对端的已就绪 link 并派发其 envelope。
		 * @param {string} remoteNodeHash 对端 nodeHash
		 * @param {object} link 链路句柄
		 * @returns {void}
		 */
		addLink(remoteNodeHash, link) {
			links.set(remoteNodeHash, link)
			link.onEnvelope((envelope, senderNodeHash) => {
				const from = senderNodeHash || remoteNodeHash
				for (const [prefix, handlers] of scopeListeners.entries())
					if (String(envelope?.scope || '').startsWith(prefix))
						for (const handler of handlers)
							void handler(from, envelope, link)
			})
		},
		/**
		 * @returns {Array<{ nodeHash: string }>} 链路邻居
		 */
		listLinks() {
			return [...links.keys()].map(nodeHash => ({ nodeHash }))
		},
		/**
		 * @param {string} targetNodeHash 目标
		 * @param {object} envelope envelope
		 * @returns {Promise<boolean>} 是否送达
		 */
		async sendToNodeLink(targetNodeHash, envelope) {
			const link = links.get(targetNodeHash)
			if (!link) return false
			try { return await link.send(envelope) } catch { return false }
		},
		/**
		 * @param {string} prefix scope 前缀
		 * @param {Function} handler 处理器
		 * @returns {() => void} 取消订阅
		 */
		subscribeScope(prefix, handler) {
			if (!scopeListeners.has(prefix)) scopeListeners.set(prefix, new Set())
			scopeListeners.get(prefix).add(handler)
			return () => scopeListeners.get(prefix)?.delete(handler)
		},
	}
}

test({
	name: 'a↔b over LAN, b↔c over nostr: a and c exchange via b (overlay relay)',
	sanitizeOps: false,
	sanitizeResources: false,
	/**
	 * @returns {Promise<void>}
	 */
	async fn() {
		clearLinkProviders()
		clearDiscoveryProviders()
		clearLanPeerHints()
		const alice = identity(51)
		const bob = identity(52)
		const carol = identity(53)

		const relay = await startFakeRelay(() => true, { broadcast: true })
		const relayUrl = `ws://127.0.0.1:${relay.port}`
		const discovery = createNostrDiscoveryProvider({ relayUrls: [relayUrl], localNodeHash: bob.nodeHash })
		registerDiscoveryProvider(discovery)

		/** @type {(() => void) | null} */
		let stopAliceLan = null
		/** @type {(() => void) | null} */
		let stopBobLan = null
		/** @type {object | null} */
		let bLinkA = null
		/** @type {object | null} */
		let cLinkBInbound = null
		/** @type {(() => void) | null} */
		let stopBSignal = null
		/** @type {(() => void) | null} */
		let stopCSignal = null
		/** @type {(() => void) | null} */
		let stopListenC = null
		/** @type {(() => void) | null} */
		let stopListenB = null
		try {
			// a↔b：真实 loopback LAN TCP。
			const aliceLan = createLanTcpLinkProvider()
			const bobLan = createLanTcpLinkProvider()
			stopAliceLan = await aliceLan.ensureListening({
				localIdentity: alice,
				/**
				 *
				 */
				onInbound() { },
			})
			stopBobLan = await bobLan.ensureListening({
				localIdentity: bob,
				/**
				 *
				 * @param link
				 */
				onInbound(link) { bLinkA = link },
			})
			noteLanPeerHint(bob.nodeHash, { host: '127.0.0.1', port: bobLan.localEndpoint().port })
			const aLinkB = await aliceLan.dial({ nodeHash: bob.nodeHash, localIdentity: alice })
			await aLinkB.ready
			await waitFor(() => !!bLinkA, 5_000)
			await bLinkA.ready

			// b↔c：单个假 nostr relay 的真实 link。
			const bLinkC = createNostrLinkProvider({
				/**
				 *
				 */
				getRelayUrls: () => [relayUrl]
			})
			const cLinkB = createNostrLinkProvider({
				/**
				 *
				 */
				getRelayUrls: () => [relayUrl]
			})
			stopBSignal = await discovery.listenNodeSignals(bob.nodeHash, bytes => {
				const packet = decryptNodeSignalPacket(bob.nodeHash, bytes)
				if (packet?.type === 'link') void bLinkC.deliverPacket(packet)
			})
			stopCSignal = await discovery.listenNodeSignals(carol.nodeHash, bytes => {
				const packet = decryptNodeSignalPacket(carol.nodeHash, bytes)
				if (packet?.type === 'link') void cLinkB.deliverPacket(packet)
			})
			stopListenC = cLinkB.ensureListening({
				localIdentity: carol,
				/**
				 *
				 * @param link
				 */
				onInbound(link) { cLinkBInbound = link },
			})
			stopListenB = bLinkC.ensureListening({
				localIdentity: bob,
				/**
				 *
				 */
				onInbound() { },
			})
			const bDialedC = await bLinkC.dial({ nodeHash: carol.nodeHash, localIdentity: bob })
			await bDialedC.ready
			await waitFor(() => !!cLinkBInbound, 5_000)
			await cLinkBInbound.ready

			// 组装 mesh：a-b 经 LAN，b-c 经 nostr；a、c 无直连。
			const aNode = createMeshNode(alice)
			aNode.addLink(bob.nodeHash, aLinkB)
			const bNode = createMeshNode(bob)
			bNode.addLink(alice.nodeHash, bLinkA)
			bNode.addLink(carol.nodeHash, bDialedC)
			const cNode = createMeshNode(carol)
			cNode.addLink(bob.nodeHash, cLinkBInbound)

			const aRouter = createOverlayRouter(aNode)
			const bRouter = createOverlayRouter(bNode)
			const cRouter = createOverlayRouter(cNode)
			/** @type {Array<{ body: unknown, meta: object }>} */
			const receivedAtC = []
			const stopRelayC = cRouter.onRelay((body, meta) => receivedAtC.push({ body, meta }))
			/** @type {unknown[]} */
			const receivedAtA = []
			const stopRelayA = aRouter.onRelay(body => receivedAtA.push(body))
			try {
				const path = await aRouter.discoverRoute(carol.nodeHash, { timeoutMs: 10_000 })
				assertEquals(path.join(','), [alice.nodeHash, bob.nodeHash, carol.nodeHash].join(','))

				await aRouter.relay(path, { hello: 'from-a', hop: 1 })
				await waitFor(() => receivedAtC.length, 5_000)
				assertEquals(receivedAtC[0].body.hello, 'from-a')
				assertEquals(receivedAtC[0].meta.path[2], carol.nodeHash, 'c reached via b relay')

				await cRouter.relay([carol.nodeHash, bob.nodeHash, alice.nodeHash], { hello: 'from-c', hop: 2 })
				await waitFor(() => receivedAtA.length, 5_000)
				assertEquals(receivedAtA[0].hello, 'from-c')
			}
			finally {
				stopRelayC()
				stopRelayA()
				aRouter.close()
				bRouter.close()
				cRouter.close()
			}
		}
		finally {
			stopListenC?.()
			stopListenB?.()
			stopBSignal?.()
			stopCSignal?.()
			stopAliceLan?.()
			stopBobLan?.()
			discovery.dispose?.()
			await relay.stop()
			clearDiscoveryProviders()
			clearLinkProviders()
			clearLanPeerHints()
		}
	},
})
