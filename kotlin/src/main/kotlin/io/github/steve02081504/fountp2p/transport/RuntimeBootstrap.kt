package io.github.steve02081504.fountp2p.transport

import io.github.steve02081504.fountp2p.core.normalizeTcpPort
import io.github.steve02081504.fountp2p.discovery.buildSignedAdvertForScope
import io.github.steve02081504.fountp2p.discovery.bt.canUseBluetoothRuntime
import io.github.steve02081504.fountp2p.discovery.bt.createBluetoothDiscoveryProvider
import io.github.steve02081504.fountp2p.discovery.clearDiscoveryProviders
import io.github.steve02081504.fountp2p.discovery.createLanDiscoveryProvider
import io.github.steve02081504.fountp2p.discovery.encryptAdvertForScope
import io.github.steve02081504.fountp2p.discovery.listDiscoveryProviders
import io.github.steve02081504.fountp2p.discovery.listenNodeSignals
import io.github.steve02081504.fountp2p.discovery.nostr.MAX_ADVERT_RELAY_POOL
import io.github.steve02081504.fountp2p.discovery.nostr.createNostrDiscoveryProvider
import io.github.steve02081504.fountp2p.discovery.nostr.getWorkingRelays
import io.github.steve02081504.fountp2p.discovery.nostr.loadRelayPool
import io.github.steve02081504.fountp2p.discovery.nostr.resolveNostrRelayUrls
import io.github.steve02081504.fountp2p.discovery.nostr.startNostrRelayDiscovery
import io.github.steve02081504.fountp2p.discovery.registerDiscoveryProvider
import io.github.steve02081504.fountp2p.discovery.startDiscoveryPresence
import io.github.steve02081504.fountp2p.discovery.unregisterDiscoveryProvider
import io.github.steve02081504.fountp2p.link.providers.LinkHandle
import io.github.steve02081504.fountp2p.link.providers.LinkProvider
import io.github.steve02081504.fountp2p.link.providers.createBleGattLinkProvider
import io.github.steve02081504.fountp2p.link.providers.createLanTcpLinkProvider
import io.github.steve02081504.fountp2p.link.providers.createWebRtcLinkProvider
import io.github.steve02081504.fountp2p.link.providers.listLinkProviders
import io.github.steve02081504.fountp2p.link.providers.nostr.createNostrLinkProvider
import io.github.steve02081504.fountp2p.link.providers.registerLinkProvider
import io.github.steve02081504.fountp2p.link.providers.unregisterLinkProvider
import io.github.steve02081504.fountp2p.node.getSignalingRuntimeConfig
import io.github.steve02081504.fountp2p.node.isConnectivityDebug
import io.github.steve02081504.fountp2p.node.nodeDebug
import io.github.steve02081504.fountp2p.node.onNodeChange
import io.github.steve02081504.fountp2p.node.shortHash
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * link registry 运行时暖机（等价 `js/transport/runtime_bootstrap.mjs`）。
 *
 * 偏离：
 * - JS 用 `setInterval` / promise；Kotlin 用 coroutine。`startNostrRelayDiscovery` 在 JS 无参，
 *   Kotlin 需显式 scope，这里用模块级 scope。
 * - JS `collectFastListenProviders` 借「isAvailable 是否返回 thenable」把异步探测的 provider 留给补监听路径；
 *   Kotlin 的 `isAvailable()` 一律是 suspend，没法同步问，所以快速路径只放本 registry 自己持有的实例。
 */

/**
 * @param provider 链路提供者
 * @return 是否由本 registry 自己持有（lan_tcp / ble_gatt 走各自的启动路径）
 */
fun providerIsRegistryOwned(provider: LinkProvider): Boolean =
	provider.id.startsWith("lan_tcp") || provider.id.startsWith("ble_gatt")

/** @param provider 链路提供者 @return 是否使用原生 probe 路径 */
fun providerHasNativeProbe(provider: LinkProvider): Boolean = provider.caps?.get("probe") == "native"

/**
 * @param provider 链路提供者
 * @return 是否需要在 runtime 暖机时补挂监听
 */
fun providerNeedsListening(provider: LinkProvider): Boolean {
	if (providerIsRegistryOwned(provider)) return false
	if (providerHasNativeProbe(provider)) return false
	// 不因「暂时不可用」而拒绝挂监听：relay 池为空/未探测时 nostr 的 isAvailable() 会是 false，
	// 而 relay 列表是在发送时解析的，先挂上监听才能收到入站 link-open（见 fount-p2p#38）。
	// Kotlin 的 `ensureListening` 带默认空实现，没法像 JS 那样问「有没有这个方法」；真返回 null 的
	// provider 在 startProviderListening 里自然不会被登记，无需在这里预判。
	return true
}

/**
 * @param ownedLanTcp 本 registry 持有的 lan_tcp
 * @param ownedBleGatt 本 registry 持有的 ble_gatt
 * @return 可快速启动监听的 provider 列表
 */
fun collectFastListenProviders(ownedLanTcp: LinkProvider?, ownedBleGatt: LinkProvider?): List<LinkProvider> {
	val out = ArrayList<LinkProvider>()
	// 自己持有的实例必须在注册/重注册时立刻挂监听，不能等 discovery 就绪：BLE 的 ensureListening
	// 在宿主未注入蓝牙运行时就是空实现（no-op），真正的可用性判断在宿主侧。
	if (ownedLanTcp != null) out.add(ownedLanTcp)
	if (ownedBleGatt != null) out.add(ownedBleGatt)
	return out
}

private val bootstrapScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

/** [createRuntimeBootstrap] 依赖。 */
class RuntimeBootstrapDeps(
	val localIdentity: Map<String, Any?>,
	val autoRegisterDiscoveryProviders: Boolean,
	val autoRegisterLinkProviders: Boolean,
	val onInboundLink: (LinkHandle) -> Unit,
	val handleIncomingSignal: suspend (ByteArray) -> Unit,
)

/** 运行时暖机句柄。 */
interface RuntimeBootstrap {
	/** @return runtime 是否已启动 */
	fun isLive(): Boolean

	/** @return 本机 lan_tcp 监听端口，未就绪为 null */
	fun lanTcpPort(): Int?

	/** @return 本 registry 持有的 lan_tcp provider */
	fun ownedLanTcp(): LinkProvider?

	/** @return 本 registry 持有的 BLE GATT provider */
	fun ownedBleGatt(): LinkProvider?

	/** 启动 discovery/link runtime（仅注册 + 调度后台暖机，不等 listen）。 */
	suspend fun ensureRuntime()

	/**
	 * @param channel 通道名
	 * @return 该 channel 可用为 true
	 */
	suspend fun ensureChannelAvailable(channel: String): Boolean

	/** 等待 lan 监听就绪。 */
	suspend fun whenListening()

	/** 等待信令监听就绪。 */
	suspend fun whenSignalListening()

	/**
	 * @param scope advert 域（`node` / `network` / `{ roomSecret }`）
	 * @return 签名后的 advert body
	 */
	suspend fun buildLocalAdvert(scope: Any? = "node"): Map<String, Any?>

	/** 热重载 discovery relay 配置。 */
	suspend fun reloadDiscoveryRelays()

	/** 关闭 runtime。 */
	suspend fun shutdown()
}

private class DefaultRuntimeBootstrap(private val deps: RuntimeBootstrapDeps) : RuntimeBootstrap {
	private val localIdentity = deps.localIdentity

	private var runtimeStarted = false
	private var runtimeStart: CompletableDeferred<Unit>? = null
	private var lanListenReady: CompletableDeferred<Unit>? = null
	private var signalListenReady: CompletableDeferred<Unit>? = null
	private var runtimeWarm: Deferred<Unit>? = null
	private var stopPresence: (() -> Unit)? = null
	private var stopSignalListener: (() -> Unit)? = null
	private var stopRelayDiscovery: (() -> Unit)? = null
	private val stopLinkListeners = LinkedHashMap<String, () -> Unit>()
	private var ownedLanTcp: LinkProvider? = null
	private var ownedBleGatt: LinkProvider? = null
	private var generation = 0
	private var reloadInflight: CompletableDeferred<Unit>? = null
	private var stopSignalingWatch: (() -> Unit)? = null

	private fun isChannelEnabled(name: String): Boolean {
		val channels = getSignalingRuntimeConfig()["channels"] as? Map<*, *> ?: return true
		return channels[name] != false
	}

	private fun registerNostrProvider() {
		unregisterDiscoveryProvider("nostr")
		registerDiscoveryProvider(
			createNostrDiscoveryProvider(
				linkedMapOf(
					"getRelayUrls" to { resolveNostrRelayUrls() },
					"localNodeHash" to (localIdentity["nodeHash"]?.toString() ?: ""),
				),
			),
		)
	}

	override fun isLive(): Boolean = runtimeStarted

	override fun lanTcpPort(): Int? {
		val endpoint = ownedLanTcp?.localEndpoint() ?: return null
		return normalizeTcpPort(endpoint["port"])
	}

	override fun ownedLanTcp(): LinkProvider? = ownedLanTcp

	override fun ownedBleGatt(): LinkProvider? = ownedBleGatt

	override suspend fun whenListening() {
		lanListenReady?.let { try { it.await() } catch (_: Exception) { } }
	}

	override suspend fun whenSignalListening() {
		signalListenReady?.let { try { it.await() } catch (_: Exception) { } }
	}

	override suspend fun buildLocalAdvert(scope: Any?): Map<String, Any?> {
		whenListening()
		val tcpPort = lanTcpPort()
		val relayData = if (scope == "network") {
			linkedMapOf<String, Any?>(
				"pool" to getWorkingRelays()
					.filter { it.rttMs != null }
					.take(MAX_ADVERT_RELAY_POOL)
					.map { linkedMapOf<String, Any?>("url" to it.url, "rttMs" to it.rttMs) },
				"listen" to resolveNostrRelayUrls(),
			)
		}
		else linkedMapOf<String, Any?>("pool" to emptyList<Any?>(), "listen" to emptyList<Any?>())
		return buildSignedAdvertForScope(scope, localIdentity, tcpPort, relayData)
	}

	private suspend fun startProviderListening(provider: LinkProvider) {
		stopLinkListeners[provider.id]?.invoke()
		try {
			val stop = provider.ensureListening(deps.onInboundLink, localIdentity)
			if (stop != null) stopLinkListeners[provider.id] = stop
		}
		catch (_: Exception) {
			// provider listen unavailable
		}
	}

	private suspend fun buildNetworkAdvertBytes(): ByteArray {
		val body = buildLocalAdvert("network")
		return encryptAdvertForScope("network", localIdentity, body)
	}

	/**
	 * 为所有「已注册、已启用、尚未监听」的 link provider 启动监听。
	 * `reconcileLinkProviders()` 重新注册的 provider 只有走到这里才会拿到 onInbound/localIdentity，
	 * 否则它会静默丢弃全部入站 link-open（见 fount-p2p#38）。
	 *
	 * 刻意不看 `isAvailable()`：relay 池为空/未探测时 nostr 的 `isAvailable()` 会是 false，而 relay 列表
	 * 是在发送时解析的；先挂上监听才能收到入站 link-open，暂时不可用不该让它变哑巴。
	 */
	private suspend fun startEnabledProviderListening() {
		if (!deps.autoRegisterLinkProviders) return
		for (provider in listLinkProviders()) {
			if (!isChannelEnabled(provider.id.split(":")[0])) continue
			if (!providerNeedsListening(provider)) continue
			if (stopLinkListeners.containsKey(provider.id)) continue
			startProviderListening(provider)
		}
	}

	private suspend fun warmListenAndDiscovery(gen: Int) {
		val listenProviders = collectFastListenProviders(ownedLanTcp, ownedBleGatt)
		val lanReady = CompletableDeferred<Unit>()
		lanListenReady = lanReady
		for (provider in listenProviders) startProviderListening(provider)
		startEnabledProviderListening()
		lanReady.complete(Unit)

		val signalReady = CompletableDeferred<Unit>()
		signalListenReady = signalReady
		try {
			try {
				lanReady.await()
			}
			catch (_: Exception) {
				// ignore
			}
			if (generation != gen || !isLive()) {
				signalReady.complete(Unit)
				return
			}
			if (listDiscoveryProviders().isEmpty()) {
				signalReady.complete(Unit)
				return
			}
			stopSignalListener = listenNodeSignals(localIdentity["nodeHash"]?.toString() ?: "") { bytes ->
				bootstrapScope.launch { try { deps.handleIncomingSignal(bytes) } catch (_: Exception) { } }
			}
			nodeDebug(
				"p2p:runtime signal listening",
				linkedMapOf(
					"self" to shortHash(localIdentity["nodeHash"]?.toString()),
					"providers" to listDiscoveryProviders().map { it.id },
				),
			)
			signalReady.complete(Unit)
		}
		catch (error: Exception) {
			signalReady.completeExceptionally(error)
		}

		try {
			try {
				signalReady.await()
			}
			catch (_: Exception) {
				// ignore
			}
			if (generation != gen || !isLive()) return
			if (listDiscoveryProviders().isEmpty()) return
			stopPresence = startDiscoveryPresence {
				linkedMapOf(
					"nodeHash" to (localIdentity["nodeHash"]?.toString() ?: ""),
					"tcpPort" to (lanTcpPort()?.toDouble()),
					"advertBody" to buildLocalAdvert("network"),
					"advertBytes" to buildNetworkAdvertBytes(),
				)
			}
			if (isConnectivityDebug())
				nodeDebug(
					"p2p:runtime presence started",
					linkedMapOf(
						"self" to shortHash(localIdentity["nodeHash"]?.toString()),
						"lanTcpPort" to (lanTcpPort()?.toDouble()),
						"relays" to resolveNostrRelayUrls().size.toDouble(),
					),
				)
		}
		catch (_: Exception) {
			// ignore
		}
	}

	private fun releaseLinkProvider(id: String) {
		val stop = stopLinkListeners.remove(id)
		try {
			stop?.invoke()
		}
		catch (_: Exception) {
			// ignore
		}
		unregisterLinkProvider(id)
	}

	private fun reconcileLinkProviders() {
		if (!deps.autoRegisterLinkProviders) return
		val present = listLinkProviders().map { it.id.split(":")[0] }.toSet()
		if (isChannelEnabled("nostr")) {
			if (!present.contains("nostr"))
				registerLinkProvider(createNostrLinkProvider(mapOf("getRelayUrls" to { resolveNostrRelayUrls() })))
		}
		else releaseLinkProvider("nostr")

		if (isChannelEnabled("lan")) {
			if (ownedLanTcp == null) {
				val provider = createLanTcpLinkProvider()
				ownedLanTcp = provider
				registerLinkProvider(provider)
			}
		}
		else if (ownedLanTcp != null) {
			releaseLinkProvider(ownedLanTcp!!.id)
			ownedLanTcp = null
		}
		if (isChannelEnabled("bt")) {
			if (ownedBleGatt == null) {
				val provider = createBleGattLinkProvider()
				ownedBleGatt = provider
				registerLinkProvider(provider)
			}
		}
		else if (ownedBleGatt != null) {
			releaseLinkProvider(ownedBleGatt!!.id)
			ownedBleGatt = null
		}
		if (isChannelEnabled("webrtc")) {
			if (listLinkProviders().none { it.id.split(":")[0] == "webrtc" })
				registerLinkProvider(createWebRtcLinkProvider())
		}
		else releaseLinkProvider("webrtc")
	}

	private fun reconcileDiscoveryProviders() {
		if (!deps.autoRegisterDiscoveryProviders) return
		val present = listDiscoveryProviders().map { it.id }.toSet()
		if (isChannelEnabled("lan")) {
			if (!present.contains("lan"))
				registerDiscoveryProvider(
					createLanDiscoveryProvider(mapOf("localNodeHash" to (localIdentity["nodeHash"]?.toString() ?: ""))),
				)
		}
		else unregisterDiscoveryProvider("lan")

		if (isChannelEnabled("nostr")) registerNostrProvider()
		else unregisterDiscoveryProvider("nostr")
		if (!isChannelEnabled("bt")) unregisterDiscoveryProvider("bt")
	}

	override suspend fun reloadDiscoveryRelays() {
		reloadInflight?.let { it.await(); return }
		val deferred = CompletableDeferred<Unit>()
		reloadInflight = deferred
		try {
			if (runtimeStart != null) {
				try {
					runtimeStart!!.await()
				}
				catch (_: Exception) {
					// ignore
				}
			}
			runtimeWarm?.let { try { it.await() } catch (_: Exception) { } }
			val gen = generation
			if (!isLive()) {
				deferred.complete(Unit)
				return
			}
			stopPresence?.invoke()
			stopSignalListener?.invoke()
			stopPresence = null
			stopSignalListener = null
			stopRelayDiscovery?.invoke()
			stopRelayDiscovery = null
			if (isChannelEnabled("nostr")) stopRelayDiscovery = startNostrRelayDiscovery(bootstrapScope)
			reconcileLinkProviders()
			reconcileDiscoveryProviders()
			if (generation != gen || !isLive()) {
				deferred.complete(Unit)
				return
			}
			// 覆盖本轮新注册/重新注册的 provider（例如关掉再打开 nostr）：只补 ownedLanTcp/BLE
			// 会让新 provider 永远拿不到 onInbound（见 fount-p2p#38）。
			startEnabledProviderListening()
			val signalReady = CompletableDeferred<Unit>()
			signalListenReady = signalReady
			try {
				if (generation == gen && isLive() && listDiscoveryProviders().isNotEmpty())
					stopSignalListener = listenNodeSignals(localIdentity["nodeHash"]?.toString() ?: "") { bytes ->
						bootstrapScope.launch { try { deps.handleIncomingSignal(bytes) } catch (_: Exception) { } }
					}
				signalReady.complete(Unit)
			}
			catch (error: Exception) {
				signalReady.completeExceptionally(error)
			}
			try {
				signalReady.await()
			}
			catch (_: Exception) {
				// ignore
			}
			if (generation != gen || !isLive()) {
				deferred.complete(Unit)
				return
			}
			stopPresence = startDiscoveryPresence {
				linkedMapOf(
					"nodeHash" to (localIdentity["nodeHash"]?.toString() ?: ""),
					"tcpPort" to (lanTcpPort()?.toDouble()),
					"advertBody" to buildLocalAdvert("network"),
					"advertBytes" to buildNetworkAdvertBytes(),
				)
			}
			deferred.complete(Unit)
		}
		catch (error: Exception) {
			deferred.completeExceptionally(error)
			throw error
		}
		finally {
			reloadInflight = null
		}
	}

	override suspend fun ensureRuntime() {
		if (runtimeStarted) return
		runtimeStart?.let { it.await(); return }
		val deferred = CompletableDeferred<Unit>()
		runtimeStart = deferred
		try {
			runtimeStarted = true
			val gen = generation
			// 先加载/播种 relay 池，再启动 NIP-66 发现。
			loadRelayPool()
			if (isChannelEnabled("nostr")) {
				if (stopRelayDiscovery == null) stopRelayDiscovery = startNostrRelayDiscovery(bootstrapScope)
			}
			else {
				stopRelayDiscovery?.invoke()
				stopRelayDiscovery = null
			}
			reconcileLinkProviders()
			if (deps.autoRegisterDiscoveryProviders) reconcileDiscoveryProviders()
			if (isConnectivityDebug())
				nodeDebug(
					"p2p:runtime ensure",
					linkedMapOf(
						"self" to shortHash(localIdentity["nodeHash"]?.toString()),
						"discovery" to listDiscoveryProviders().map { it.id },
						"relays" to resolveNostrRelayUrls(),
					),
				)
			if (stopSignalingWatch == null)
				stopSignalingWatch = onNodeChange { event, _ ->
					if (event == "signaling-changed")
						bootstrapScope.launch { try { reloadDiscoveryRelays() } catch (_: Exception) { } }
				}
			runtimeWarm = bootstrapScope.async { warmListenAndDiscovery(gen) }
			deferred.complete(Unit)
		}
		catch (error: Exception) {
			deferred.completeExceptionally(error)
			throw error
		}
		finally {
			runtimeStart = null
		}
	}

	override suspend fun ensureChannelAvailable(channel: String): Boolean {
		if (!deps.autoRegisterDiscoveryProviders) return false
		runtimeStart?.let { it.await() }
		if (!isLive()) return false
		return when (channel) {
			"lan" -> {
				whenListening()
				isChannelEnabled("lan")
			}
			"nostr", "webrtc" -> {
				whenSignalListening()
				isChannelEnabled(channel)
			}
			"bt" -> {
				if (!isChannelEnabled("bt")) return false
				if (listDiscoveryProviders().any { it.id == "bt" }) return true
				if (!isLive()) return false
				if (canUseBluetoothRuntime()) {
					registerDiscoveryProvider(createBluetoothDiscoveryProvider())
					reloadDiscoveryRelays()
				}
				listDiscoveryProviders().any { it.id == "bt" }
			}
			else -> throw IllegalArgumentException("p2p: unknown channel $channel")
		}
	}

	override suspend fun shutdown() {
		runtimeStarted = false
		generation++
		stopSignalingWatch?.invoke()
		stopSignalingWatch = null
		stopPresence?.invoke()
		stopSignalListener?.invoke()
		stopPresence = null
		stopSignalListener = null
		stopRelayDiscovery?.invoke()
		stopRelayDiscovery = null
		withTimeoutOrNull(500) { runtimeWarm?.await() }
		for (stop in stopLinkListeners.values) try {
			stop()
		}
		catch (_: Exception) {
			// ignore
		}
		stopLinkListeners.clear()
		clearDiscoveryProviders()
		ownedLanTcp?.let { unregisterLinkProvider(it.id) }
		ownedLanTcp = null
		ownedBleGatt?.let { unregisterLinkProvider(it.id) }
		ownedBleGatt = null
		lanListenReady = null
		signalListenReady = null
		runtimeWarm = null
		reloadInflight = null
	}
}

/**
 * @param deps 依赖注入
 * @return 运行时暖机句柄
 */
fun createRuntimeBootstrap(deps: RuntimeBootstrapDeps): RuntimeBootstrap = DefaultRuntimeBootstrap(deps)
