package io.github.steve02081504.fountp2p.transport

import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.core.compareHex64Asc
import io.github.steve02081504.fountp2p.core.hexToBytes
import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.crypto.keyPairFromSeed
import io.github.steve02081504.fountp2p.discovery.noteAdvertPeerHints
import io.github.steve02081504.fountp2p.discovery.setDiscoveryPeerClueListener
import io.github.steve02081504.fountp2p.discovery.watchVerifiedNodeAdvert
import io.github.steve02081504.fountp2p.discovery.setDiscoveryLinkDialer
import io.github.steve02081504.fountp2p.link.providers.LinkHandle
import io.github.steve02081504.fountp2p.link.providers.LinkProvider
import io.github.steve02081504.fountp2p.link.providers.listLinkProviders
import io.github.steve02081504.fountp2p.node.ensureNodeSeed
import io.github.steve02081504.fountp2p.node.getNodeHash
import io.github.steve02081504.fountp2p.node.loadPeerPoolView
import io.github.steve02081504.fountp2p.node.nodeDebug
import io.github.steve02081504.fountp2p.node.shortHash
import io.github.steve02081504.fountp2p.overlay.OverlayLinkRef
import io.github.steve02081504.fountp2p.overlay.OverlayRegistry
import io.github.steve02081504.fountp2p.overlay.OverlayRouter
import io.github.steve02081504.fountp2p.overlay.createOverlayRouter
import io.github.steve02081504.fountp2p.transport.node_scope.LinkRegistryNodeScopeBridge
import io.github.steve02081504.fountp2p.transport.node_scope.configureNodeScopeLinkBridge
import io.github.steve02081504.fountp2p.utils.LruMap
import io.github.steve02081504.fountp2p.utils.ms
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.launch

/**
 * P2P 链路注册表（等价 `js/transport/link_registry.mjs`）：discovery、信令、直连与 overlay relay。
 *
 * 偏离：
 * - JS `createLinkRegistry(options)` 内建 `createRuntimeBootstrap`；Kotlin 允许注入
 *   [bootstrapFactory]（测试用假实现），默认仍走真实 [createRuntimeBootstrap]。
 * - JS 的 `registry` 是无类型对象，Kotlin 以接口（[GroupRegistry] / [MeshRegistry] /
 *   [OverlayRegistry]）暴露视图。
 * - JS 在文件加载时即绑定默认单例；Kotlin [getLinkRegistry] 创建后注入 node scope 桥。
 */

/** dial exhausted 后的初始冷却。 */
private val DIAL_COOLDOWN_BASE_MS: Long = ms("30s")

/** dial 冷却上限。 */
private val DIAL_COOLDOWN_MAX_MS: Long = ms("10m")

private val linkRegistryScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

private fun nowMs(): Double = System.currentTimeMillis().toDouble()

/** [createLinkRegistry] 选项；null 字段表示沿用默认。 */
class LinkRegistryOptions(
	var localIdentity: Map<String, Any?>? = null,
	var iceServers: List<Any?>? = null,
	var maxActive: Int? = null,
	var meshKeepalive: Boolean? = null,
	var autoRegisterDiscoveryProviders: Boolean? = null,
	var autoRegisterLinkProviders: Boolean? = null,
)

/** dial 冷却条目。 */
private class DialCool(var until: Double, var failures: Int)

/** 活跃链路引用。 */
data class LinkRef(val nodeHash: String, val link: LinkHandle)

/** scope authorizer。 */
typealias ScopeAuthorizer = suspend (
	scope: String,
	senderNodeHash: String,
	envelope: Map<String, Any?>,
	link: LinkHandle?,
) -> Boolean

/**
 * @param options createLinkRegistry 选项
 * @return 规范化后的本地身份
 */
fun resolveLocalIdentity(options: Map<String, Any?>?): Map<String, Any?> {
	if (options != null &&
		options["nodeHash"] != null &&
		options["nodePubKey"] != null &&
		options["secretKey"] != null
	)
		return linkedMapOf(
			"nodeHash" to options["nodeHash"],
			"nodePubKey" to options["nodePubKey"],
			"secretKey" to options["secretKey"],
		)
	val secretKey = hexToBytes(ensureNodeSeed())
	val keyPair = keyPairFromSeed(secretKey)
	return linkedMapOf(
		"nodeHash" to getNodeHash(),
		"nodePubKey" to bytesToHex(keyPair.publicKey),
		"secretKey" to secretKey,
	)
}

private fun subscribeBucket(
	buckets: MutableMap<String, MutableSet<(String, Map<String, Any?>) -> Unit>>,
	key: String,
	listener: (String, Map<String, Any?>) -> Unit,
): () -> Unit {
	val set = buckets.getOrPut(key) { LinkedHashSet() }
	set.add(listener)
	return {
		val current = buckets[key]
		if (current != null) {
			current.remove(listener)
			if (current.isEmpty()) buckets.remove(key)
		}
		Unit
	}
}

/**
 * P2P 链路注册表。
 */
class LinkRegistry internal constructor(
	private val options: LinkRegistryOptions,
	bootstrapFactory: (RuntimeBootstrapDeps) -> RuntimeBootstrap,
) : GroupRegistry {
	/** 本地身份。 */
	override val localIdentity: Map<String, Any?> = resolveLocalIdentity(options.localIdentity)

	private var iceServers: List<Any?> = options.iceServers?.takeIf { it.isNotEmpty() } ?: DEFAULT_ICE_SERVERS
	private var maxActive: Int = maxOf(4, options.maxActive ?: 32)
	private val savedMaxActive: Int = maxActive
	private val meshKeepaliveEnabled: Boolean = options.meshKeepalive != false
	private var priorityWeightFunction: ((nodeHash: String) -> Double)? = null

	private val links = LinkedHashMap<String, LinkHandle>()
	private val inflights = LinkedHashMap<String, Deferred<LinkHandle?>>()
	private val dialCooldown = LruMap<String, DialCool>(1024)
	private val signalSessions = LinkedHashMap<String, BufferedSignalSession>()
	private val scopeInterests = LinkedHashMap<String, Set<String>>()
	private val scopeListeners = LinkedHashMap<String, MutableSet<(String, Map<String, Any?>) -> Unit>>()
	private val scopeAuthorizers = LinkedHashMap<String, ScopeAuthorizer>()
	private val linkUpListeners = LinkedHashSet<(String, LinkHandle?) -> Unit>()
	private val linkDownListeners = LinkedHashSet<(String, String) -> Unit>()
	/** 最近 advert 时间戳（nodeHash → epoch ms）。 */
	val recentAdverts: LruMap<String, Any?> = LruMap(1024)
	private var overlayRouter: OverlayRouter? = null
	private val selfNodeHash: String = localIdentity["nodeHash"]?.toString() ?: ""

	private var handleIncomingSignal: suspend (ByteArray) -> Unit = { }
	private var dialOfferAnswer: suspend (LinkProvider, String) -> LinkHandle? = { _, _ -> null }

	private val bootstrap: RuntimeBootstrap = bootstrapFactory(
		RuntimeBootstrapDeps(
			localIdentity = localIdentity,
			autoRegisterDiscoveryProviders = options.autoRegisterDiscoveryProviders != false,
			autoRegisterLinkProviders = options.autoRegisterLinkProviders != false,
			onInboundLink = ::onInboundLink,
			handleIncomingSignal = { bytes -> handleIncomingSignal(bytes) },
		),
	)

	private val meshRegistryView = object : MeshRegistry {
		override val localIdentity: Map<String, Any?> get() = this@LinkRegistry.localIdentity
		override fun listLinks(): List<MeshLinkRef> =
			this@LinkRegistry.listLinks().map { MeshLinkRef(it.nodeHash, it.link.asMeshLink()) }
		override fun getLink(nodeHash: String): MeshLink? = this@LinkRegistry.getLink(nodeHash)?.asMeshLink()
		override suspend fun ensureLinkToNode(nodeHash: String): MeshLink? =
			this@LinkRegistry.ensureLinkToNode(nodeHash)?.asMeshLink()
		override fun onLinkUp(listener: (String) -> Unit): () -> Unit = this@LinkRegistry.onLinkUp(listener)
		override fun onLinkDown(listener: (String, String) -> Unit): () -> Unit =
			this@LinkRegistry.onLinkDown(listener)
	}

	private val overlayRegistryView = object : OverlayRegistry {
		override val localIdentity: Map<String, Any?> get() = this@LinkRegistry.localIdentity
		override fun listLinks(): List<OverlayLinkRef> =
			this@LinkRegistry.listLinks().map { OverlayLinkRef(it.nodeHash, it.link) }
		override suspend fun sendToNodeLink(nodeHash: String, envelope: Map<String, Any?>): Boolean =
			this@LinkRegistry.sendToNodeLink(nodeHash, envelope)
		override fun subscribeScope(
			prefix: String,
			handler: (String, Map<String, Any?>) -> Unit,
		): () -> Unit = this@LinkRegistry.subscribeScope(prefix, handler)
	}

	private val meshKeepalive: MeshKeepalive = createMeshKeepalive(meshRegistryView, meshKeepaliveEnabled)

	/** 探索链路集合（trim 时优先驱逐）。 */
	private val exploreLinkHashes: MutableSet<String> get() = meshKeepalive.exploreLinkHashes

	private val peerHealth = createPeerHealthTracker(
		object : PeerHealthRegistry {
			override fun onLinkUp(listener: (String, PeerHealthLink?) -> Unit): () -> Unit =
				this@LinkRegistry.onLinkUp { nodeHash, link -> listener(nodeHash, link?.asPeerHealthLink()) }

			override fun onLinkDown(listener: (String) -> Unit): () -> Unit =
				this@LinkRegistry.onLinkDown { nodeHash, _ -> listener(nodeHash) }
		},
	)

	init {
		val dial = createOfferAnswerDial(
			OfferAnswerDialDeps(
				localIdentity = localIdentity,
				iceServers = { iceServers },
				signalSessions = signalSessions,
				registerResolvedLink = { nodeHash, link -> registerResolvedLink(nodeHash, link) },
				trimToBudget = { trimToBudget() },
				getCanonicalLink = { nodeHash -> links[nodeHash] },
			),
		)
		handleIncomingSignal = dial.handleIncomingSignal
		dialOfferAnswer = dial.dialOfferAnswer

		setDiscoveryLinkDialer { nodeHash -> ensureLinkToNode(nodeHash) }
		setDiscoveryPeerClueListener { nodeHash ->
			if (!nodeHash.isNullOrEmpty()) {
				dialCooldown.remove(nodeHash)
				recentAdverts.touch(nodeHash, nowMs())
			}
		}
	}

	/**
	 * 择链：更高 level 优先；同 level 时保留由较小 nodeHash 发起的那条。
	 * @param link 候选链路
	 * @param remoteNodeHash 远端节点 64 hex
	 * @param against 当前规范链
	 * @return 候选链应保留为规范链时 true
	 */
	private fun linkIsPreferred(link: LinkHandle, remoteNodeHash: String, against: LinkHandle?): Boolean {
		val level = link.level
		val againstLevel = against?.level ?: 0.0
		if (against != null && level != againstLevel) return level > againstLevel
		val cmp = compareHex64Asc(selfNodeHash, remoteNodeHash)
		return if (link.initiator) cmp < 0 else cmp > 0
	}

	private fun wireLink(remoteNodeHash: String, link: LinkHandle) {
		link.onEnvelope { envelope, senderNodeHash ->
			linkRegistryScope.launch {
				try {
					dispatchEnvelope(senderNodeHash, envelope, link)
				}
				catch (_: Exception) {
					// ignore
				}
			}
		}
		link.onDown { reason ->
			val wasCanonical = links[remoteNodeHash] === link
			if (!wasCanonical) return@onDown
			links.remove(remoteNodeHash)
			emitLinkDown(remoteNodeHash, reason)
		}
	}

	private fun emitLinkUp(nodeHash: String, link: LinkHandle?) {
		for (listener in linkUpListeners.toList()) try {
			listener(nodeHash, link)
		}
		catch (_: Throwable) {
			// ignore
		}
	}

	private fun emitLinkDown(nodeHash: String, reason: String) {
		for (listener in linkDownListeners.toList()) try {
			listener(nodeHash, reason)
		}
		catch (_: Throwable) {
			// ignore
		}
	}

	/**
	 * 注册已建立的链路：level 优先，同 level 再按 initiator/nodeHash glare 规则择一。
	 * @param remoteNodeHash 远端节点 64 hex
	 * @param candidate 候选链路
	 */
	suspend fun registerResolvedLink(remoteNodeHash: String, candidate: LinkHandle) {
		val normalized = remoteNodeHash
		val existing = links[normalized]
		if (existing != null && existing !== candidate && !linkIsPreferred(candidate, normalized, existing)) {
			candidate.close(if (candidate.level != existing.level) "provider-loser" else "glare-loser")
			return
		}
		links[normalized] = candidate
		wireLink(normalized, candidate)
		if (existing != null && existing !== candidate)
			existing.close(if (candidate.level != existing.level) "provider-replaced" else "glare-replaced")
		emitLinkUp(normalized, candidate)
	}

	private fun onInboundLink(link: LinkHandle) {
		linkRegistryScope.launch {
			try {
				link.ready.await()
				val remote = isHex64(link.nodeHash)
				if (remote == null) {
					link.close("inbound-no-nodehash")
					return@launch
				}
				registerResolvedLink(remote, link)
			}
			catch (_: Exception) {
				// ignore failed inbound
			}
		}
	}

	private fun scopeWeight(remoteNodeHash: String): Double {
		var weight = priorityWeightFunction?.invoke(remoteNodeHash) ?: 0.0
		for (hashes in scopeInterests.values)
			if (hashes.contains(remoteNodeHash)) weight += 1.0
		return weight
	}

	/** 超出 maxActive 时驱逐：探索链优先于熟人/scope 权重。 */
	private suspend fun trimToBudget() {
		if (links.size < maxActive) return
		val peers = loadPeerPoolView()
		val victimHash = pickMeshEvictionVictim(
			links.keys.toList(),
			exploreLinkHashes,
			peers.trustedPeers,
		) { nodeHash -> scopeWeight(nodeHash) }
		val victimLink = victimHash?.let { links[it] }
		if (victimLink != null) victimLink.close("budget-evict")
	}

	/**
	 * 经非 offer/answer provider 拨号。
	 * @param provider 链路提供者
	 * @param remoteNodeHash 远端 64 hex
	 * @return 当前规范链；失败 null
	 */
	private suspend fun dialProvider(provider: LinkProvider, remoteNodeHash: String): LinkHandle? {
		trimToBudget()
		val link = provider.dial(
			linkedMapOf(
				"nodeHash" to remoteNodeHash,
				"localIdentity" to localIdentity,
				"iceServers" to iceServers,
			),
		) ?: return null
		link.ready.await()
		registerResolvedLink(remoteNodeHash, link)
		return links[remoteNodeHash]
	}

	/** 按 level 降序尝试各 LinkProvider，不可用/不可达/失败则回落。 */
	override suspend fun ensureLinkToNode(remoteNodeHash: String): LinkHandle? {
		bootstrap.ensureRuntime()
		bootstrap.whenSignalListening()
		val normalized = remoteNodeHash
		if (normalized.isEmpty() || normalized == selfNodeHash) return null
		links[normalized]?.let { return it }
		inflights[normalized]?.let { return it.await() }
		val cool = dialCooldown[normalized]
		val now = nowMs()
		if (cool != null) {
			if (now < cool.until) {
				nodeDebug(
					"p2p:dial cooldown",
					linkedMapOf(
						"peer" to shortHash(normalized),
						"failures" to cool.failures.toDouble(),
						"retryInMs" to (cool.until - now),
					),
				)
				return null
			}
			dialCooldown.remove(normalized)
		}
		val task = linkRegistryScope.async(start = CoroutineStart.LAZY) {
			try {
				nodeDebug("p2p:dial start", linkedMapOf("peer" to shortHash(normalized)))
				io.github.steve02081504.fountp2p.discovery.prepareConnectToNode(normalized)
				val providers = listLinkProviders()
				for (provider in providers) {
					try {
						val reachable = provider.canReach(linkedMapOf("nodeHash" to normalized))
						if (!reachable) {
							nodeDebug(
								"p2p:dial skip",
								linkedMapOf("peer" to shortHash(normalized), "provider" to provider.id, "reason" to "canReach=false"),
							)
							continue
						}
						if (!provider.isAvailable()) {
							nodeDebug(
								"p2p:dial skip",
								linkedMapOf("peer" to shortHash(normalized), "provider" to provider.id, "reason" to "isAvailable=false"),
							)
							continue
						}
						nodeDebug("p2p:dial try", linkedMapOf("peer" to shortHash(normalized), "provider" to provider.id))
						if (provider.caps?.get("needsOfferAnswer") == true) {
							val link = dialOfferAnswer(provider, normalized)
							if (link != null) {
								dialCooldown.remove(normalized)
								nodeDebug("p2p:dial ok", linkedMapOf("peer" to shortHash(normalized), "provider" to provider.id))
								return@async link
							}
							nodeDebug("p2p:dial miss", linkedMapOf("peer" to shortHash(normalized), "provider" to provider.id))
							continue
						}
						val link = dialProvider(provider, normalized)
						if (link != null) {
							dialCooldown.remove(normalized)
							nodeDebug("p2p:dial ok", linkedMapOf("peer" to shortHash(normalized), "provider" to provider.id))
							return@async link
						}
						nodeDebug("p2p:dial miss", linkedMapOf("peer" to shortHash(normalized), "provider" to provider.id))
					}
					catch (error: Exception) {
						nodeDebug(
							"p2p:dial fail",
							linkedMapOf(
								"peer" to shortHash(normalized),
								"provider" to provider.id,
								"err" to (error.message ?: error.toString()),
							),
						)
					}
				}
				val failures = (cool?.failures ?: 0) + 1
				val delay = minOf(
					DIAL_COOLDOWN_MAX_MS.toDouble(),
					DIAL_COOLDOWN_BASE_MS.toDouble() * Math.pow(2.0, minOf(failures - 1, 5).toDouble()),
				)
				dialCooldown.touch(normalized, DialCool(nowMs() + delay, failures))
				nodeDebug(
					"p2p:dial exhausted",
					linkedMapOf("peer" to shortHash(normalized), "cooldownMs" to delay, "failures" to failures.toDouble()),
				)
				null
			}
			finally {
				inflights.remove(normalized)
			}
		}
		inflights[normalized] = task
		task.start()
		return task.await()
	}

	/** 启动 discovery/link runtime 并开启 mesh keepalive。 */
	override suspend fun ensureRuntime() {
		bootstrap.ensureRuntime()
		meshKeepalive.start()
	}

	/**
	 * 经已有直连发送 envelope。
	 * @param remoteNodeHash 远端节点 64 hex
	 * @param envelope 信封
	 * @return 是否发送成功
	 */
	override suspend fun sendToNodeLink(remoteNodeHash: String, envelope: Map<String, Any?>): Boolean =
		sendDirectToNodeLink(remoteNodeHash, envelope) || relayEnvelopeToNode(remoteNodeHash, envelope)

	private suspend fun sendDirectToNodeLink(remoteNodeHash: String, envelope: Map<String, Any?>): Boolean {
		if (remoteNodeHash.isEmpty()) return false
		val link = links[remoteNodeHash] ?: return false
		return try {
			link.send(envelope)
		}
		catch (_: Exception) {
			false
		}
	}

	/** @return 懒创建 overlay 路由器 */
	fun getOverlayRouter(): OverlayRouter {
		overlayRouter?.let { return it }
		val router = createOverlayRouter(overlayRegistryView)
		router.onRelay { body, meta ->
			linkRegistryScope.launch {
				try {
					dispatchEnvelope(meta.path.first(), body as? Map<String, Any?> ?: return@launch, null)
				}
				catch (_: Exception) {
					// ignore
				}
			}
		}
		overlayRouter = router
		return router
	}

	/** @return overlay 路由器单例 */
	fun ensureOverlayRouter(): OverlayRouter = getOverlayRouter()

	/**
	 * 经 overlay 多跳 relay envelope 到无直连的节点。
	 * @param remoteNodeHash 远端节点 64 hex
	 * @param envelope 信封
	 * @return 是否 relay 成功
	 */
	suspend fun relayEnvelopeToNode(remoteNodeHash: String, envelope: Map<String, Any?>): Boolean {
		if (links.isEmpty() || envelope["scope"] == "overlay") return false
		return try {
			val overlay = getOverlayRouter()
			val path = overlay.discoverRoute(remoteNodeHash)
			overlay.relay(path, envelope)
			true
		}
		catch (_: Exception) {
			false
		}
	}

	/**
	 * 将入站 envelope 派发到 scope 监听器（经 authorizer 校验）。
	 * @param senderNodeHash 发送方节点 64 hex
	 * @param envelope 信封
	 * @param link 来源链路
	 */
	suspend fun dispatchEnvelope(senderNodeHash: String, envelope: Map<String, Any?>, link: LinkHandle?) {
		val scope = envelope["scope"]?.toString() ?: ""
		for ((prefix, authorizer) in scopeAuthorizers.entries.toList())
			if (scope.startsWith(prefix))
				if (!authorizer(scope, senderNodeHash, envelope, link)) return

		for ((prefix, listeners) in scopeListeners.entries.toList())
			if (scope.startsWith(prefix))
				for (listener in listeners.toList())
					listener(senderNodeHash, envelope)
	}

	/**
	 * @param prefix scope 前缀
	 * @param listener 入站回调
	 * @return 取消订阅
	 */
	override fun subscribeScope(prefix: String, listener: (String, Map<String, Any?>) -> Unit): () -> Unit =
		subscribeBucket(scopeListeners, prefix, listener)

	/**
	 * @param prefix scope 前缀
	 * @param authorizer 校验函数
	 * @return 取消注册
	 */
	fun registerScopeAuthorizer(prefix: String, authorizer: ScopeAuthorizer): () -> Unit {
		scopeAuthorizers[prefix] = authorizer
		return { scopeAuthorizers.remove(prefix); Unit }
	}

	/**
	 * @param nodeHash 节点 64 hex
	 * @return 链路实例；不存在时 null
	 */
	override fun getLink(nodeHash: String): LinkHandle? = links[nodeHash]

	/** @return 所有活跃链路 */
	fun listLinks(): List<LinkRef> = links.entries.map { LinkRef(it.key, it.value) }

	/**
	 * @param nodeHash 节点 64 hex
	 * @param reason 关闭原因
	 */
	suspend fun closeLink(nodeHash: String, reason: String = "manual-close") {
		links[nodeHash]?.close(reason)
	}

	/**
	 * @param listener link up 回调
	 * @return 取消订阅
	 */
	fun onLinkUp(listener: (nodeHash: String, link: LinkHandle?) -> Unit): () -> Unit {
		linkUpListeners.add(listener)
		return { linkUpListeners.remove(listener); Unit }
	}

	/** @param listener link up 回调（仅 nodeHash） */
	override fun onLinkUp(listener: (nodeHash: String) -> Unit): () -> Unit =
		onLinkUp { nodeHash, _ -> listener(nodeHash) }

	/**
	 * @param listener link down 回调
	 * @return 取消订阅
	 */
	override fun onLinkDown(listener: (nodeHash: String, reason: String) -> Unit): () -> Unit {
		linkDownListeners.add(listener)
		return { linkDownListeners.remove(listener); Unit }
	}

	/**
	 * @param scope scope 名称
	 * @param nodeHashes 成员 nodeHash 列表
	 */
	override fun registerScopeInterest(scope: String, nodeHashes: List<String>) {
		scopeInterests[scope] = nodeHashes.mapNotNull { isHex64(it) }.toSet()
	}

	/**
	 * @param scope scope 名称
	 */
	override fun releaseScopeInterest(scope: String) {
		scopeInterests.remove(scope)
	}

	/**
	 * @param value 最大并发活跃链路数
	 */
	suspend fun setMaxActive(value: Any?) {
		val raw = (value as? Number)?.toDouble()
		maxActive = if (raw == null || raw.isNaN() || raw == 0.0) savedMaxActive
		else maxOf(4, minOf(128, Math.floor(raw).toInt()))
		trimToBudget()
	}

	/** @return 当前 maxActive */
	fun getMaxActive(): Int = maxActive

	/** @param servers ICE 列表 */
	fun setIceServers(servers: List<Any?>?) {
		iceServers = servers?.takeIf { it.isNotEmpty() } ?: DEFAULT_ICE_SERVERS
	}

	/** @return 当前 ICE 列表 */
	fun getIceServers(): List<Any?> = iceServers

	/** @param weightFunction 额外 trim 权重；null 清除 */
	fun setPriorityWeightFunction(weightFunction: ((nodeHash: String) -> Double)?) {
		priorityWeightFunction = weightFunction
	}

	/**
	 * @param nodeHash 节点 64 hex
	 * @return 额外路由 trim 权重
	 */
	fun getPriorityWeight(nodeHash: String): Double = priorityWeightFunction?.invoke(nodeHash) ?: 0.0

	/**
	 * @param nodeHash 节点 64 hex
	 * @return 健康记录；无记录时 null
	 */
	fun getPeerHealth(nodeHash: String): PeerHealthEntry? = peerHealth.getPeerHealth(nodeHash)

	/** @return 所有邻居健康记录 */
	fun listPeerHealth(): List<PeerHealthEntry> = peerHealth.listPeerHealth()

	/**
	 * @param listener 变化回调
	 * @return 取消订阅
	 */
	fun onPeerHealth(listener: (String, PeerHealthEntry) -> Unit): () -> Unit = peerHealth.onPeerHealth(listener)

	/**
	 * 监听指定节点的 advert（per-hash，无 topic）。
	 * @param nodeHash 目标节点 64 hex
	 * @param onAdvert advert 回调
	 * @return 取消函数
	 */
	suspend fun watchNodeAdvert(
		nodeHash: String,
		onAdvert: suspend (verifiedNodeHash: String, body: Map<String, Any?>) -> Unit,
	): () -> Unit = watchVerifiedNodeAdvert(nodeHash) { verifiedNodeHash, body, meta ->
		noteAdvertPeerHints(verifiedNodeHash, body, meta)
		recentAdverts.touch(verifiedNodeHash, nowMs())
		dialCooldown.remove(verifiedNodeHash)
		onAdvert(verifiedNodeHash, body)
	}

	// ---- GroupRegistry 透传 ----

	override suspend fun buildLocalAdvert(options: Map<String, Any?>): Map<String, Any?> =
		bootstrap.buildLocalAdvert(options)

	suspend fun ensureChannelAvailable(channel: String): Boolean = bootstrap.ensureChannelAvailable(channel)

	suspend fun whenListening() = bootstrap.whenListening()

	suspend fun whenSignalListening() = bootstrap.whenSignalListening()

	suspend fun reloadDiscoveryRelays() = bootstrap.reloadDiscoveryRelays()

	/** @return 本机 lan_tcp 监听端口 */
	fun lanTcpPort(): Int? = bootstrap.lanTcpPort()

	fun isLive(): Boolean = bootstrap.isLive()

	fun ownedLanTcp(): LinkProvider? = bootstrap.ownedLanTcp()

	fun ownedBleGatt(): LinkProvider? = bootstrap.ownedBleGatt()

	/** 关闭 registry：停止 discovery、overlay 并断开所有链路。 */
	suspend fun shutdown() {
		meshKeepalive.stop()
		peerHealth.stop()
		setDiscoveryLinkDialer(null)
		setDiscoveryPeerClueListener(null)
		bootstrap.shutdown()
		overlayRouter?.close()
		overlayRouter = null
		for (link in links.values.toList()) link.close("registry-shutdown")
		links.clear()
		inflights.clear()
		dialCooldown.clear()
		for (session in signalSessions.values) session.clear()
		signalSessions.clear()
	}
}

/** @return 适配为 [MeshLink]（每次调用新建包装） */
private fun LinkHandle.asMeshLink(): MeshLink = object : MeshLink {
	override val providerId: String? get() = this@asMeshLink.providerId
	override suspend fun close(reason: String) = this@asMeshLink.close(reason)
}

/** @return 适配为 [PeerHealthLink]（LinkHandle 无 onRtt，RTT 不更新） */
private fun LinkHandle.asPeerHealthLink(): PeerHealthLink = object : PeerHealthLink {
	override val providerId: String? get() = this@asPeerHealthLink.providerId
	override fun stats(): Map<String, Any?>? = this@asPeerHealthLink.stats()
	override fun onDown(callback: (reason: String?) -> Unit): () -> Unit =
		this@asPeerHealthLink.onDown { reason -> callback(reason) }
}

/**
 * 创建 P2P 链路注册表。
 * @param options 选项
 * @param bootstrapFactory 运行时暖机工厂（测试可注入假实现）
 * @return link registry 接口
 */
@JvmOverloads
fun createLinkRegistry(
	options: LinkRegistryOptions = LinkRegistryOptions(),
	bootstrapFactory: (RuntimeBootstrapDeps) -> RuntimeBootstrap = ::createRuntimeBootstrap,
): LinkRegistry = LinkRegistry(options, bootstrapFactory)

private var defaultRegistry: LinkRegistry? = null
private var pendingRegistryOptions: LinkRegistryOptions? = null

/**
 * 在首次 getLinkRegistry 前配置默认 registry 选项。
 * @param options createLinkRegistry 选项
 */
fun configureLinkRegistry(options: LinkRegistryOptions) {
	if (defaultRegistry != null) throw IllegalStateException("p2p: configureLinkRegistry must run before getLinkRegistry")
	val pending = pendingRegistryOptions ?: LinkRegistryOptions().also { pendingRegistryOptions = it }
	options.localIdentity?.let { pending.localIdentity = it }
	options.iceServers?.let { pending.iceServers = it }
	options.maxActive?.let { pending.maxActive = it }
	options.meshKeepalive?.let { pending.meshKeepalive = it }
	options.autoRegisterDiscoveryProviders?.let { pending.autoRegisterDiscoveryProviders = it }
	options.autoRegisterLinkProviders?.let { pending.autoRegisterLinkProviders = it }
}

/** 重置 link registry 运行时（测试用）。 */
fun resetLinkRegistryForTests() {
	defaultRegistry = null
	pendingRegistryOptions = null
	pendingScopeAuthorizers.clear()
}

/** 注册阶段暂存的 scope authorizer。 */
private class PendingScopeAuthorizer(
	val prefix: String,
	val authorizer: ScopeAuthorizer,
) {
	var unregister: (() -> Unit)? = null
}

private val pendingScopeAuthorizers = ArrayList<PendingScopeAuthorizer>()

/** @return 进程级默认 link registry 单例 */
fun getLinkRegistry(): LinkRegistry {
	defaultRegistry?.let { return it }
	val registry = createLinkRegistry(pendingRegistryOptions ?: LinkRegistryOptions())
	defaultRegistry = registry
	pendingRegistryOptions = null
	configureNodeScopeLinkBridge(LinkRegistryNodeScopeBridge(registry))
	for (entry in pendingScopeAuthorizers) entry.unregister = registry.registerScopeAuthorizer(entry.prefix, entry.authorizer)
	pendingScopeAuthorizers.clear()
	return registry
}

/**
 * 注册默认 registry 的 scope authorizer（不急切创建 registry）。
 * @param prefix scope 前缀
 * @param authorizer 校验函数
 * @return 取消注册
 */
fun registerScopeAuthorizer(prefix: String, authorizer: ScopeAuthorizer): () -> Unit {
	defaultRegistry?.let { return it.registerScopeAuthorizer(prefix, authorizer) }
	val entry = PendingScopeAuthorizer(prefix, authorizer)
	pendingScopeAuthorizers.add(entry)
	return {
		pendingScopeAuthorizers.remove(entry)
		entry.unregister?.invoke()
		Unit
	}
}

/** 确保 overlay 路由器已创建。 */
fun ensureOverlayRouter(): OverlayRouter = getLinkRegistry().ensureOverlayRouter()

/** 热重载 discovery relay 配置。 */
suspend fun reloadDiscoveryRelays() = getLinkRegistry().reloadDiscoveryRelays()

/** 确保到 nodeHash 的活跃链路。 */
suspend fun ensureLinkToNode(nodeHash: String): LinkHandle? = getLinkRegistry().ensureLinkToNode(nodeHash)

/** 确保指定 channel 可用。 */
suspend fun ensureChannelAvailable(channel: String): Boolean = getLinkRegistry().ensureChannelAvailable(channel)

/** @return 活跃链路 */
fun getLink(nodeHash: String): LinkHandle? = getLinkRegistry().getLink(nodeHash)

/** @return 所有活跃链路 */
fun listLinks(): List<LinkRef> = getLinkRegistry().listLinks()

/** @param nodeHash 节点 64 hex @param reason 关闭原因 */
suspend fun closeLink(nodeHash: String, reason: String = "manual-close") = getLinkRegistry().closeLink(nodeHash, reason)

/** 经活跃链路向节点发送 envelope。 */
suspend fun sendToNodeLink(remoteNodeHash: String, envelope: Map<String, Any?>): Boolean =
	getLinkRegistry().sendToNodeLink(remoteNodeHash, envelope)

/** 经 overlay 多跳 relay envelope。 */
suspend fun relayEnvelopeToNode(remoteNodeHash: String, envelope: Map<String, Any?>): Boolean =
	getLinkRegistry().relayEnvelopeToNode(remoteNodeHash, envelope)

/** @param listener link up 回调 @return 取消订阅 */
fun onLinkUp(listener: (nodeHash: String, link: LinkHandle?) -> Unit): () -> Unit = getLinkRegistry().onLinkUp(listener)

/** @param listener link down 回调 @return 取消订阅 */
fun onLinkDown(listener: (nodeHash: String, reason: String) -> Unit): () -> Unit = getLinkRegistry().onLinkDown(listener)

/** @param scope scope 名称 @param nodeHashes 成员 nodeHash 列表 */
fun registerScopeInterest(scope: String, nodeHashes: List<String>) = getLinkRegistry().registerScopeInterest(scope, nodeHashes)

/** @param scope scope 名称 */
fun releaseScopeInterest(scope: String) = getLinkRegistry().releaseScopeInterest(scope)

/** @param prefix scope 前缀 @param listener 入站回调 @return 取消订阅 */
fun subscribeScope(prefix: String, listener: (String, Map<String, Any?>) -> Unit): () -> Unit =
	getLinkRegistry().subscribeScope(prefix, listener)

/** @return 健康记录 */
fun getPeerHealth(nodeHash: String): PeerHealthEntry? = getLinkRegistry().getPeerHealth(nodeHash)

/** @return 所有健康记录 */
fun listPeerHealth(): List<PeerHealthEntry> = getLinkRegistry().listPeerHealth()

/** @return 取消订阅 */
fun onPeerHealth(listener: (String, PeerHealthEntry) -> Unit): () -> Unit = getLinkRegistry().onPeerHealth(listener)
