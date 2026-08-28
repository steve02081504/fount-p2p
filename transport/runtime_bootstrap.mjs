import { normalizeTcpPort } from '../core/tcp_port.mjs'
import {
	buildSignedAdvertForScope,
	clearDiscoveryProviders,
	encryptAdvertForScope,
	listDiscoveryProviders,
	listenNodeSignals,
	registerDiscoveryProvider,
	startDiscoveryPresence,
	unregisterDiscoveryProvider,
} from '../discovery/index.mjs'
import { createLanDiscoveryProvider } from '../discovery/lan.mjs'
import {
	createNostrDiscoveryProvider,
	getListenRelays,
	getWorkingRelays,
	loadRelayPool,
	resolveNostrRelayUrls,
	startNostrRelayDiscovery,
} from '../discovery/nostr/index.mjs'
import { createBleGattLinkProvider } from '../link/providers/ble_gatt.mjs'
import {
	listLinkProviders,
	registerLinkProvider,
	unregisterLinkProvider,
} from '../link/providers/index.mjs'
import { createLanTcpLinkProvider } from '../link/providers/lan_tcp.mjs'
import { createNostrLinkProvider } from '../link/providers/nostr/index.mjs'
import { createWebRtcLinkProvider } from '../link/providers/webrtc.mjs'
import { getSignalingRuntimeConfig, onNodeChange } from '../node/instance.mjs'
import { isConnectivityDebug, nodeDebug, shortHash } from '../node/log.mjs'

/**
 * @param {import('../link/providers/index.mjs').LinkProvider} provider 链路提供者
 * @returns {boolean} 是否使用原生 probe 路径
 */
export function providerHasNativeProbe(provider) {
	return provider.caps?.probe === 'native'
}

/**
 * @param {import('../link/providers/index.mjs').LinkProvider | null} ownedLanTcp 本 registry 持有的 lan_tcp
 * @returns {import('../link/providers/index.mjs').LinkProvider[]} 可快速启动监听的 provider 列表
 */
export function collectFastListenProviders(ownedLanTcp) {
	/** @type {import('../link/providers/index.mjs').LinkProvider[]} */
	const listenProviders = []
	if (ownedLanTcp) listenProviders.push(ownedLanTcp)
	for (const provider of listLinkProviders()) {
		const { id } = provider
		if (id.startsWith('lan_tcp') || id.startsWith('ble_gatt')) continue
		if (!provider.ensureListening) continue
		if (providerHasNativeProbe(provider)) continue
		if (provider.isAvailable)
			try {
				const available = provider.isAvailable()
				if (available?.then) continue
				if (!available) continue
			}
			catch { continue }

		listenProviders.push(provider)
	}
	return listenProviders
}

/**
 * @param {object} deps 依赖注入
 * @param {{ nodeHash: string, nodePubKey: string, secretKey: Uint8Array }} deps.localIdentity 本地身份
 * @param {boolean} deps.autoRegisterDiscoveryProviders 是否自动注册 discovery provider
 * @param {boolean} deps.autoRegisterLinkProviders 是否自动注册内置 link provider
 * @param {(link: object) => void} deps.onInboundLink 入站链路回调
 * @param {(bytes: Uint8Array) => Promise<void>} deps.handleIncomingSignal 入站加密信令处理
 * @returns {object} 运行时暖机句柄
 */
export function createRuntimeBootstrap(deps) {
	const {
		localIdentity,
		autoRegisterDiscoveryProviders,
		autoRegisterLinkProviders,
		onInboundLink,
		handleIncomingSignal,
	} = deps

	let runtimeStarted = false
	/** @type {Promise<void> | null} */
	let runtimeStart = null
	/** @type {Promise<void> | null} */
	let lanListenReady = null
	/** @type {Promise<void> | null} */
	let signalListenReady = null
	/** @type {Promise<void> | null} */
	let runtimeWarm = null
	/** @type {(() => void) | null} */
	let stopPresence = null
	/** @type {(() => void) | null} */
	let stopSignalListener = null
	/** @type {(() => void) | null} */
	let stopRelayDiscovery = null
	/** @type {Map<string, () => void>} */
	const stopLinkListeners = new Map()
	/** @type {ReturnType<typeof createLanTcpLinkProvider> | null} */
	let ownedLanTcp = null
	/** @type {ReturnType<typeof createBleGattLinkProvider> | null} */
	let ownedBleGatt = null
	let generation = 0
	/** @type {Promise<void> | null} */
	let reloadInflight = null
	/** @type {(() => void) | null} */
	let stopSignalingWatch = null

	/**
	 * @param {string} name 通道名
	 * @returns {boolean} 该通道是否启用（默认启用，false 禁用）
	 */
	function isChannelEnabled(name) {
		return getSignalingRuntimeConfig().channels[name] !== false
	}

	/** 注册/替换 nostr discovery provider */
	function registerNostrProvider() {
		unregisterDiscoveryProvider('nostr')
		registerDiscoveryProvider(createNostrDiscoveryProvider({
			getRelayUrls: resolveNostrRelayUrls,
			localNodeHash: localIdentity.nodeHash,
		}))
	}

	/**
	 * @returns {boolean} runtime 是否已启动
	 */
	function isLive() {
		return runtimeStarted
	}

	/**
	 * @returns {number | null} 本机 lan_tcp 监听端口，未就绪为 null
	 */
	function lanTcpPort() {
		const endpoint = ownedLanTcp?.localEndpoint ? ownedLanTcp.localEndpoint() : null
		return normalizeTcpPort(endpoint?.port)
	}

	/**
	 * @returns {Promise<void>}
	 */
	async function whenListening() {
		if (lanListenReady) await lanListenReady.catch(() => { })
	}

	/**
	 * @returns {Promise<void>}
	 */
	async function whenSignalListening() {
		if (signalListenReady) await signalListenReady.catch(() => { })
	}

	/**
	 * @param {import('../discovery/adverts.mjs').AdvertScope} [scope='node'] advert 域
	 * @returns {Promise<object>} 签名后的 advert body
	 */
	async function buildLocalAdvert(scope = 'node') {
		await whenListening()
		const tcpPort = lanTcpPort()
		// 仅 network 域注入 relay 字段；LAN 域传空对象（签名消息仍含空的 relays: 段）。
		const relayData = scope === 'network'
			? {
				pool: getWorkingRelays().slice(0, 16).map(entry => ({ url: entry.url, rttMs: entry.rttMs ?? undefined })),
				listen: getListenRelays().map(entry => entry.url),
			}
			: { pool: [], listen: [] }
		return await buildSignedAdvertForScope(scope, localIdentity, tcpPort ?? undefined, relayData)
	}

	/**
	 * @param {import('../link/providers/index.mjs').LinkProvider} provider 链路提供者
	 * @returns {Promise<void>}
	 */
	async function startProviderListening(provider) {
		if (!provider.ensureListening) return
		stopLinkListeners.get(provider.id)?.()
		try {
			const stop = await provider.ensureListening({
				localIdentity,
				onInbound: onInboundLink,
			})
			if (stop) stopLinkListeners.set(provider.id, stop)
		}
		catch { /* provider listen unavailable */ }
	}

	/**
	 * @returns {Promise<Uint8Array>} 加密后的全网 advert 字节
	 */
	async function buildNetworkAdvertBytes() {
		const body = await buildLocalAdvert('network')
		return encryptAdvertForScope('network', localIdentity, body)
	}

	/**
	 * @param {number} gen 启动世代
	 * @returns {Promise<void>}
	 */
	function warmListenAndDiscovery(gen) {
		const listenProviders = collectFastListenProviders(ownedLanTcp)
		lanListenReady = Promise.all(listenProviders.map(provider => startProviderListening(provider))).then(() => { })
		signalListenReady = (async () => {
			await lanListenReady.catch(() => { })
			if (generation !== gen || !isLive()) return
			if (!listDiscoveryProviders().length) return
			stopSignalListener = await listenNodeSignals(localIdentity.nodeHash, bytes => {
				void handleIncomingSignal(bytes).catch(() => { })
			})
			nodeDebug('p2p:runtime signal listening', {
				self: shortHash(localIdentity.nodeHash),
				providers: listDiscoveryProviders().map(provider => provider.id),
			})
		})()
		return (async () => {
			await signalListenReady.catch(() => { })
			if (generation !== gen || !isLive()) return
			if (!listDiscoveryProviders().length) return
			stopPresence = await startDiscoveryPresence(async () => ({
				nodeHash: localIdentity.nodeHash,
				tcpPort: lanTcpPort() ?? undefined,
				advertBody: await buildLocalAdvert('network'),
				advertBytes: await buildNetworkAdvertBytes(),
			}))
			if (isConnectivityDebug())
				nodeDebug('p2p:runtime presence started', {
					self: shortHash(localIdentity.nodeHash),
					lanTcpPort: lanTcpPort(),
					relays: resolveNostrRelayUrls().length,
				})
		})()
	}

	/**
	 * 释放指定 id 的 link provider 监听与注册
	 * @param {id: string} id link provider id
	 */
	function releaseLinkProvider(id) {
		const stop = stopLinkListeners.get(id)
		stopLinkListeners.delete(id)
		try { stop?.() } catch { /* ignore */ }
		unregisterLinkProvider(id)
	}

	/** 按 channels 配置同步 link provider（启用注册 / 禁用注销） */
	function reconcileLinkProviders() {
		if (!autoRegisterLinkProviders) return
		const present = new Set(listLinkProviders().map(provider => provider.id.split(':')[0]))
		if (isChannelEnabled('nostr')) {
			if (!present.has('nostr'))
				registerLinkProvider(createNostrLinkProvider({ getRelayUrls: resolveNostrRelayUrls }))
		}
		else releaseLinkProvider('nostr')

		if (isChannelEnabled('lan')) {
			if (!ownedLanTcp) {
				ownedLanTcp = createLanTcpLinkProvider()
				registerLinkProvider(ownedLanTcp)
			}
		}
		else if (ownedLanTcp) {
			releaseLinkProvider(ownedLanTcp.id)
			ownedLanTcp = null
		}
		if (isChannelEnabled('bt')) {
			if (!ownedBleGatt) {
				ownedBleGatt = createBleGattLinkProvider()
				registerLinkProvider(ownedBleGatt)
			}
		}
		else if (ownedBleGatt) {
			releaseLinkProvider(ownedBleGatt.id)
			ownedBleGatt = null
		}
		if (isChannelEnabled('webrtc')) {
			if (!listLinkProviders().some(provider => provider.id.split(':')[0] === 'webrtc'))
				registerLinkProvider(createWebRtcLinkProvider())
		}
		else releaseLinkProvider('webrtc')
	}

	/** 按 channels 配置同步 discovery provider（启用注册 / 禁用注销；BT discovery 由 ensureChannelAvailable 显式注册） */
	function reconcileDiscoveryProviders() {
		if (!autoRegisterDiscoveryProviders) return
		const present = new Set(listDiscoveryProviders().map(provider => provider.id))
		if (isChannelEnabled('lan')) {
			if (!present.has('lan'))
				registerDiscoveryProvider(createLanDiscoveryProvider({ localNodeHash: localIdentity.nodeHash }))
		}
		else unregisterDiscoveryProvider('lan')

		if (isChannelEnabled('nostr')) registerNostrProvider()
		else unregisterDiscoveryProvider('nostr')
		if (!isChannelEnabled('bt')) unregisterDiscoveryProvider('bt')
	}

	/**
	 * @returns {Promise<void>}
	 */
	async function reloadDiscoveryRelays() {
		if (reloadInflight) return await reloadInflight
		reloadInflight = (async () => {
			if (runtimeStart) await runtimeStart
			await runtimeWarm?.catch(() => { })
			const gen = generation
			if (!isLive()) return
			stopPresence?.()
			stopSignalListener?.()
			stopPresence = null
			stopSignalListener = null
			// 重启 NIP-66 发现并同步池文件。
			stopRelayDiscovery?.()
			stopRelayDiscovery = startNostrRelayDiscovery()
			loadRelayPool()
			reconcileLinkProviders()
			reconcileDiscoveryProviders()
			if (generation !== gen || !isLive()) return
			if (ownedLanTcp && !stopLinkListeners.has(ownedLanTcp.id))
				await startProviderListening(ownedLanTcp)
			if (ownedBleGatt && !stopLinkListeners.has(ownedBleGatt.id)
				&& await Promise.resolve(ownedBleGatt.isAvailable()))
				await startProviderListening(ownedBleGatt)
			signalListenReady = (async () => {
				if (generation !== gen || !isLive()) return
				if (!listDiscoveryProviders().length) return
				stopSignalListener = await listenNodeSignals(localIdentity.nodeHash, bytes => {
					void handleIncomingSignal(bytes).catch(() => { })
				})
			})()
			await signalListenReady.catch(() => { })
			if (generation !== gen || !isLive()) return
			stopPresence = await startDiscoveryPresence(async () => ({
				nodeHash: localIdentity.nodeHash,
				tcpPort: lanTcpPort() ?? undefined,
				advertBody: await buildLocalAdvert('network'),
				advertBytes: await buildNetworkAdvertBytes(),
			}))
		})()
		try {
			await reloadInflight
		}
		finally {
			reloadInflight = null
		}
	}

	/**
	 * @returns {Promise<void>}
	 */
	async function ensureRuntime() {
		if (runtimeStarted) return
		if (runtimeStart) return await runtimeStart
		runtimeStart = (async () => {
			runtimeStarted = true
			const gen = generation
			// 先加载/播种 relay 池，再启动 NIP-66 发现（首轮异步，不阻塞 startup）。
			loadRelayPool()
			if (!stopRelayDiscovery) stopRelayDiscovery = startNostrRelayDiscovery()
			reconcileLinkProviders()
			if (autoRegisterDiscoveryProviders)
				reconcileDiscoveryProviders()
			if (isConnectivityDebug())
				nodeDebug('p2p:runtime ensure', {
					self: shortHash(localIdentity.nodeHash),
					discovery: listDiscoveryProviders().map(provider => provider.id),
					relays: resolveNostrRelayUrls(),
				})
			if (!stopSignalingWatch)
				stopSignalingWatch = onNodeChange(event => {
					if (event === 'signaling-changed')
						void reloadDiscoveryRelays().catch(() => { })
				})
			runtimeWarm = warmListenAndDiscovery(gen)
			void runtimeWarm.catch(() => { })
		})()
		try {
			await runtimeStart
		}
		finally {
			runtimeStart = null
		}
	}

	/**
	 * 确保指定 channel 可用：重 channel（bt）做探测并注册 discovery；其余 await 其渐进式就绪。
	 * @param {string} channel 通道名
	 * @returns {Promise<boolean>} 该 channel 可用为 true
	 */
	async function ensureChannelAvailable(channel) {
		if (!autoRegisterDiscoveryProviders) return false
		if (runtimeStart) await runtimeStart
		if (!isLive()) return false
		switch (channel) {
			case 'lan':
				await whenListening()
				return isChannelEnabled('lan')
			case 'nostr':
			case 'webrtc':
				await whenSignalListening()
				return isChannelEnabled(channel)
			case 'bt': {
				if (!isChannelEnabled('bt')) return false
				if (listDiscoveryProviders().some(provider => provider.id === 'bt')) return true
				const bt = await import('../discovery/bt/index.mjs')
				if (!isLive()) return false
				if (await bt.canUseBluetoothRuntime()) {
					registerDiscoveryProvider(bt.createBluetoothDiscoveryProvider())
					await reloadDiscoveryRelays()
				}
				return listDiscoveryProviders().some(provider => provider.id === 'bt')
			}
			default:
				throw new Error(`p2p: unknown channel ${channel}`)
		}
	}

	/**
	 * @returns {Promise<void>}
	 */
	async function shutdown() {
		runtimeStarted = false
		generation++
		stopSignalingWatch?.()
		stopSignalingWatch = null
		stopPresence?.()
		stopSignalListener?.()
		stopPresence = null
		stopSignalListener = null
		stopRelayDiscovery?.()
		stopRelayDiscovery = null
		await Promise.race([
			runtimeWarm?.catch(() => { }) ?? Promise.resolve(),
			new Promise(resolve => setTimeout(resolve, 500)),
		])
		for (const stop of stopLinkListeners.values())
			try { stop() } catch { /* ignore */ }
		stopLinkListeners.clear()
		clearDiscoveryProviders()
		if (ownedLanTcp) {
			unregisterLinkProvider(ownedLanTcp.id)
			ownedLanTcp = null
		}
		if (ownedBleGatt) {
			unregisterLinkProvider(ownedBleGatt.id)
			ownedBleGatt = null
		}
		lanListenReady = null
		signalListenReady = null
		runtimeWarm = null
		reloadInflight = null
	}

	return {
		ensureRuntime,
		ensureChannelAvailable,
		whenListening,
		whenSignalListening,
		buildLocalAdvert,
		lanTcpPort,
		/**
		 * @returns {ReturnType<typeof createLanTcpLinkProvider> | null} 本 registry 持有的 lan_tcp provider
		 */
		ownedLanTcp: () => ownedLanTcp,
		/**
		 * @returns {ReturnType<typeof createBleGattLinkProvider> | null} 本 registry 持有的 BLE GATT provider
		 */
		ownedBleGatt: () => ownedBleGatt,
		reloadDiscoveryRelays,
		shutdown,
	}
}
