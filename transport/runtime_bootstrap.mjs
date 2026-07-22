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
import { mergeSignalingRelayUrls, createNostrDiscoveryProvider } from '../discovery/nostr.mjs'
import { createBleGattLinkProvider } from '../link/providers/ble_gatt.mjs'
import {
	listLinkProviders,
	registerLinkProvider,
	unregisterLinkProvider,
} from '../link/providers/index.mjs'
import { createLanTcpLinkProvider } from '../link/providers/lan_tcp.mjs'
import { createWebRtcLinkProvider } from '../link/providers/webrtc.mjs'
import { getNodeTransportSettings } from '../node/identity.mjs'
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
		const id = String(provider.id)
		if (id.startsWith('lan_tcp') || id.startsWith('ble_gatt')) continue
		if (typeof provider.ensureListening !== 'function') continue
		if (providerHasNativeProbe(provider)) continue
		if (typeof provider.isAvailable === 'function')
			try {
				const available = provider.isAvailable()
				if (available && typeof available.then === 'function') continue
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
	/** @type {Promise<void> | null} */
	let bluetoothWarm = null
	/** @type {(() => void) | null} */
	let stopPresence = null
	/** @type {(() => void) | null} */
	let stopSignalListener = null
	/** @type {Array<() => void>} */
	const stopLinkListeners = []
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
	 * @returns {string[]} 当前 Nostr relay URL 列表
	 */
	function resolveNostrRelayUrls() {
		return getSignalingRuntimeConfig().relayOverride
			?? mergeSignalingRelayUrls(getNodeTransportSettings().relayUrls)
	}

	/**
	 * @returns {void}
	 */
	function registerDiscoveryDefaults() {
		const providerIds = new Set(listDiscoveryProviders().map(provider => provider.id))
		if (!providerIds.has('lan'))
			registerDiscoveryProvider(createLanDiscoveryProvider({
				localNodeHash: localIdentity.nodeHash,
			}))
		if (!providerIds.has('nostr'))
			registerNostrProvider()
	}

	/**
	 * @returns {void}
	 */
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
	 * @returns {Promise<void>}
	 */
	async function ensureLinkProviders() {
		if (!autoRegisterLinkProviders) return
		if (!ownedLanTcp) {
			ownedLanTcp = createLanTcpLinkProvider()
			registerLinkProvider(ownedLanTcp)
		}
		if (!ownedBleGatt) {
			ownedBleGatt = createBleGattLinkProvider()
			registerLinkProvider(ownedBleGatt)
		}
		const ids = new Set(listLinkProviders().map(provider => provider.id))
		if (!ids.has('webrtc'))
			registerLinkProvider(createWebRtcLinkProvider())
	}

	/**
	 * @returns {number | null} 本机 lan_tcp 监听端口，未就绪为 null
	 */
	function lanTcpPort() {
		const endpoint = typeof ownedLanTcp?.localEndpoint === 'function' ? ownedLanTcp.localEndpoint() : null
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
		return await buildSignedAdvertForScope(scope, localIdentity, tcpPort ?? undefined)
	}

	/**
	 * @param {import('../link/providers/index.mjs').LinkProvider} provider 链路提供者
	 * @returns {Promise<void>}
	 */
	async function startProviderListening(provider) {
		if (typeof provider.ensureListening !== 'function') return
		try {
			const stop = await provider.ensureListening({
				localIdentity,
				onInbound: onInboundLink,
			})
			if (typeof stop === 'function') stopLinkListeners.push(stop)
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
	async function warmBluetoothTask(gen) {
		if (autoRegisterDiscoveryProviders) {
			const providerIds = new Set(listDiscoveryProviders().map(provider => provider.id))
			if (!providerIds.has('bt')) {
				const bt = await import('../discovery/bt/index.mjs').catch(() => null)
				if (generation !== gen || !isLive()) return
				if (await bt?.canUseBluetoothDiscovery?.()) {
					if (generation !== gen || !isLive()) return
					const provider = bt.createBluetoothDiscoveryProvider()
					registerDiscoveryProvider(provider)
					if (generation !== gen || !isLive()) return
					if (typeof provider.startPresence === 'function')
						try {
							const stop = await provider.startPresence(async () => ({
								nodeHash: localIdentity.nodeHash,
								advertBytes: await buildNetworkAdvertBytes(),
							}))
							if (typeof stop === 'function' && generation === gen && isLive()) {
								const prev = stopPresence
								/**
								 *
								 */
								stopPresence = () => { try { stop() } catch { /* ignore */ }; prev?.() }
							}
						}
						catch { /* ignore */ }
					if (provider.caps?.canSignal && typeof provider.listenNodeSignals === 'function')
						try {
							const stop = await provider.listenNodeSignals(localIdentity.nodeHash, bytes => {
								void handleIncomingSignal(bytes).catch(() => { })
							})
							if (typeof stop === 'function' && generation === gen && isLive()) {
								const prev = stopSignalListener
								/**
								 *
								 */
								stopSignalListener = () => { try { stop() } catch { /* ignore */ }; prev?.() }
							}
						}
						catch { /* ignore */ }
				}
			}
		}
		if (generation !== gen || !isLive()) return
		if (ownedBleGatt && await Promise.resolve(ownedBleGatt.isAvailable())) {
			if (generation !== gen || !isLive()) return
			await startProviderListening(ownedBleGatt)
		}
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
	 * @returns {Promise<void>}
	 */
	async function reloadDiscoveryRelays() {
		if (!runtimeStarted || !autoRegisterDiscoveryProviders) return
		if (reloadInflight) return await reloadInflight
		reloadInflight = (async () => {
			const gen = generation
			stopPresence?.()
			stopSignalListener?.()
			stopPresence = null
			stopSignalListener = null
			registerNostrProvider()
			if (generation !== gen || !isLive()) return
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
			await ensureLinkProviders()
			if (autoRegisterDiscoveryProviders)
				registerDiscoveryDefaults()
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
			bluetoothWarm = warmBluetoothTask(gen).catch(() => { })
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
		await Promise.race([
			runtimeWarm?.catch(() => { }) ?? Promise.resolve(),
			new Promise(resolve => setTimeout(resolve, 500)),
		])
		for (const stop of stopLinkListeners.splice(0))
			try { stop() } catch { /* ignore */ }
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
		bluetoothWarm = null
		reloadInflight = null
	}

	return {
		ensureRuntime,
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
