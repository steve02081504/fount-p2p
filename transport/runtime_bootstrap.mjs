import { normalizeTcpPort } from '../core/tcp_port.mjs'
import { advertiseTopic, listenSignals, listDiscoveryProviders, registerDiscoveryProvider } from '../discovery/index.mjs'
import { createMdnsDiscoveryProvider } from '../discovery/mdns.mjs'
import { mergeSignalingRelayUrls, createNostrDiscoveryProvider } from '../discovery/nostr.mjs'
import { buildSignedAdvert } from '../link/handshake.mjs'
import { createBleGattLinkProvider } from '../link/providers/ble_gatt.mjs'
import {
	listLinkProviders,
	registerLinkProvider,
	unregisterLinkProvider,
} from '../link/providers/index.mjs'
import { createLanTcpLinkProvider } from '../link/providers/lan_tcp.mjs'
import { createWebRtcLinkProvider } from '../link/providers/webrtc.mjs'
import { getNodeTransportSettings } from '../node/identity.mjs'
import { getSignalingRuntimeConfig } from '../node/instance.mjs'

import { encryptSignalPacket } from './signal_crypto.mjs'

/**
 * Provider 是否会在 isAvailable() 调用时触发 native/异步探测（不得在 ensureRuntime 快路径调用）。
 * @param {import('../link/providers/index.mjs').LinkProvider} provider 链路提供者
 * @returns {boolean} `caps.probe === 'native'` 时 true
 */
export function providerHasNativeProbe(provider) {
	return provider.caps?.probe === 'native'
}

/**
 * 收集快路径应 listen 的 provider（仅 owned lan_tcp + 同步可用者）。
 * 切勿调用 caps.probe==='native' 的 isAvailable（会触发 ble/webrtc 探测）。
 * @param {import('../link/providers/index.mjs').LinkProvider | null} ownedLanTcp 本 registry 持有的 lan_tcp
 * @returns {import('../link/providers/index.mjs').LinkProvider[]} 可在 ensureRuntime 快路径 listen 的 provider
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
				// 未标 probe:native 却返回 thenable：跳过，勿 await。
				if (available && typeof available.then === 'function') continue
				if (!available) continue
			}
			catch { continue }

		listenProviders.push(provider)
	}
	return listenProviders
}

/**
 * Discovery + link listen 暖机（ensureRuntime 立即返回；listen/公网/BT 后台渐进）。
 * @param {object} deps 依赖注入
 * @param {{ nodeHash: string, nodePubKey: string, secretKey: Uint8Array }} deps.localIdentity 本地身份
 * @param {string} deps.selfTopic 本机 rendezvous topic
 * @param {boolean} deps.autoRegisterDiscoveryProviders 是否自动注册 discovery provider
 * @param {boolean} deps.autoRegisterLinkProviders 是否自动注册内置 link provider
 * @param {(link: object) => void} deps.onInboundLink 入站链路回调
 * @param {(bytes: Uint8Array) => Promise<void>} deps.handleIncomingSignal 入站加密信令处理
 * @returns {{
 *   ensureRuntime: () => Promise<void>,
 *   whenListening: () => Promise<void>,
 *   whenSignalListening: () => Promise<void>,
 *   buildLocalAdvert: (topic: string) => Promise<object>,
 *   lanTcpPort: () => number | null,
 *   ownedLanTcp: () => object | null,
 *   ownedBleGatt: () => object | null,
 *   shutdown: () => Promise<void>,
 * }} 运行时暖机句柄
 */
export function createRuntimeBootstrap(deps) {
	const {
		localIdentity,
		selfTopic,
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
	/** @type {Promise<void> | null} selfTopic listenSignals 已挂上（offer/answer dial 前必须等） */
	let signalListenReady = null
	/** @type {Promise<void> | null} */
	let runtimeWarm = null
	/** @type {Promise<void> | null} */
	let bluetoothWarm = null
	/** @type {(() => void) | null} */
	let stopAdvert = null
	/** @type {(() => void) | null} */
	let stopSignalListener = null
	/** @type {Array<() => void>} */
	const stopLinkListeners = []
	/** @type {ReturnType<typeof createLanTcpLinkProvider> | null} */
	let ownedLanTcp = null
	/** @type {ReturnType<typeof createBleGattLinkProvider> | null} */
	let ownedBleGatt = null
	/** @type {number} shutdown 时递增，后台任务检查后退出 */
	let generation = 0

	/**
	 * 暖机是否仍在运行（shutdown 后为 false）。
	 * @returns {boolean} runtime 已启动且未 shutdown 时 true
	 */
	function isLive() {
		return runtimeStarted
	}

	/**
	 * 自动注册默认 LinkProvider（lan_tcp / webrtc / ble_gatt）。
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
	 * 本 registry 的 LAN TCP 监听端口。
	 * @returns {number | null} listen 端口；未 listen 为 null
	 */
	function lanTcpPort() {
		const endpoint = typeof ownedLanTcp?.localEndpoint === 'function' ? ownedLanTcp.localEndpoint() : null
		return normalizeTcpPort(endpoint?.port)
	}

	/**
	 * 等待本地 lan_tcp listen 落定。shell / startNode 不应调用。
	 * @returns {Promise<void>}
	 */
	async function whenListening() {
		if (lanListenReady) await lanListenReady.catch(() => { })
	}

	/**
	 * 等待 selfTopic 信令监听挂上（needsOfferAnswer dial 前调用）。
	 * @returns {Promise<void>}
	 */
	async function whenSignalListening() {
		if (signalListenReady) await signalListenReady.catch(() => { })
	}

	/**
	 * 构造带本机身份与（若已 listen）tcpPort 的签名 advert。
	 * @param {string} topic 广播主题
	 * @returns {Promise<object>} 签名 advert
	 */
	async function buildLocalAdvert(topic) {
		await whenListening()
		const tcpPort = lanTcpPort()
		return await buildSignedAdvert(topic, Date.now(), {
			...localIdentity,
			...tcpPort != null ? { tcpPort } : {},
		})
	}

	/**
	 * 对单个 link provider 调用 ensureListening，收集 stop。
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
		catch { /* provider listen unavailable — normal degrade */ }
	}

	/**
	 * 把晚注册 provider 的 stop 链到现有 cleanup。
	 * @param {'signal' | 'advert'} kind 停止钩子类型
	 * @param {() => void} stop 新 provider 的取消函数
	 * @returns {void}
	 */
	function chainStop(kind, stop) {
		if (kind === 'signal') {
			const prev = stopSignalListener
			/**
			 *
			 */
			stopSignalListener = () => {
				try { stop() } catch { /* ignore */ }
				prev?.()
			}
			return
		}
		const prev = stopAdvert
		/**
		 *
		 */
		stopAdvert = () => {
			try { stop() } catch { /* ignore */ }
			prev?.()
		}
	}

	/**
	 * 后台探测 BT discovery / ble_gatt listen。
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
					if (provider.caps?.canSignal && typeof provider.onSignal === 'function')
						try {
							const stop = await provider.onSignal(selfTopic, bytes => {
								void handleIncomingSignal(bytes).catch(() => { })
							})
							if (typeof stop === 'function' && generation === gen && isLive())
								chainStop('signal', stop)
						}
						catch { /* ignore */ }
					if (provider.caps?.canDiscover && typeof provider.advertise === 'function')
						try {
							const stop = await provider.advertise(selfTopic, encryptSignalPacket(selfTopic, {
								type: 'advert',
								body: await buildLocalAdvert(selfTopic),
							}))
							if (typeof stop === 'function' && generation === gen && isLive())
								chainStop('advert', stop)
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
	 * 后台：lan_tcp listen → selfTopic listenSignals/advertise。
	 * @param {number} gen 启动世代（shutdown 时递增以作废后台任务）
	 * @returns {Promise<void>}
	 */
	function warmListenAndDiscovery(gen) {
		const listenProviders = collectFastListenProviders(ownedLanTcp)
		// 同步挂上 Promise，避免 ensureRuntime 返回后 buildLocalAdvert 看不到 lanListenReady。
		lanListenReady = Promise.all(listenProviders.map(provider => startProviderListening(provider))).then(() => { })
		signalListenReady = (async () => {
			await lanListenReady.catch(() => { })
			if (generation !== gen || !isLive()) return
			if (!listDiscoveryProviders().length) return
			stopSignalListener = await listenSignals(selfTopic, bytes => {
				void handleIncomingSignal(bytes).catch(() => { })
			})
		})()
		return (async () => {
			await signalListenReady.catch(() => { })
			if (generation !== gen || !isLive()) return
			if (!listDiscoveryProviders().length) return
			stopAdvert = await advertiseTopic(selfTopic, encryptSignalPacket(selfTopic, {
				type: 'advert',
				body: await buildLocalAdvert(selfTopic),
			}))
		})()
	}

	/**
	 * 仅注册 provider 并调度后台暖机后立即返回。
	 * @returns {Promise<void>}
	 */
	async function ensureRuntime() {
		if (runtimeStarted) return
		if (runtimeStart) return await runtimeStart
		runtimeStart = (async () => {
			runtimeStarted = true
			const gen = generation
			await ensureLinkProviders()
			if (autoRegisterDiscoveryProviders) {
				const providerIds = new Set(listDiscoveryProviders().map(provider => provider.id))
				if (!providerIds.has('mdns'))
					registerDiscoveryProvider(createMdnsDiscoveryProvider())
				if (!providerIds.has('nostr'))
					registerDiscoveryProvider(createNostrDiscoveryProvider({
						relayUrls: getSignalingRuntimeConfig().relayOverride
							?? mergeSignalingRelayUrls(getNodeTransportSettings().relayUrls),
					}))
			}
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
	 * 停止暖机与 owned providers（链路表由 registry 自行清理）。
	 * 不 await bluetoothWarm：noble/poweredOn 可能挂死；generation 已作废其后副作用。
	 * @returns {Promise<void>}
	 */
	async function shutdown() {
		runtimeStarted = false
		generation++
		await runtimeWarm?.catch(() => { })
		stopAdvert?.()
		stopSignalListener?.()
		stopAdvert = null
		stopSignalListener = null
		for (const stop of stopLinkListeners.splice(0))
			try { stop() } catch { /* ignore */ }
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
	}

	return {
		ensureRuntime,
		whenListening,
		whenSignalListening,
		buildLocalAdvert,
		lanTcpPort,
		/** @returns {ReturnType<typeof createLanTcpLinkProvider> | null} 本 registry 持有的 lan_tcp */
		ownedLanTcp: () => ownedLanTcp,
		/** @returns {ReturnType<typeof createBleGattLinkProvider> | null} 本 registry 持有的 ble_gatt */
		ownedBleGatt: () => ownedBleGatt,
		shutdown,
	}
}
