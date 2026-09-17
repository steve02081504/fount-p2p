package io.github.steve02081504.fountp2p.discovery.nostr

import io.github.steve02081504.fountp2p.core.bytesToBase64
import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.crypto.randomBytes
import io.github.steve02081504.fountp2p.discovery.DiscoveryProvider
import io.github.steve02081504.fountp2p.discovery.ingestEncryptedAdvert
import io.github.steve02081504.fountp2p.discovery.internal.encryptSignalPacket
import io.github.steve02081504.fountp2p.discovery.internal.groupRendezvousKey
import io.github.steve02081504.fountp2p.discovery.internal.networkRendezvousKey
import io.github.steve02081504.fountp2p.discovery.internal.nodeRendezvousKey
import io.github.steve02081504.fountp2p.discovery.noteAdvertPeerHints
import io.github.steve02081504.fountp2p.discovery.noteDiscoveryPeerClue
import io.github.steve02081504.fountp2p.node.getNodeTransportSettings
import io.github.steve02081504.fountp2p.node.getSignalingRuntimeConfig
import io.github.steve02081504.fountp2p.node.nodeDebug
import io.github.steve02081504.fountp2p.node.shortHash
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Nostr network advert 事件 kind（addressable，可存储）。 */
const val NOSTR_ADVERT_KIND = 30787

/** Nostr signal 事件 kind（ephemeral，实时转发）。 */
const val NOSTR_SIGNAL_KIND = 20787

/** 打广告用的话题 tag（hashtag，NIP-01）。 */
private val NOSTR_TOPIC_TAG = listOf("t", "fount")

private const val ADVERT_TTL_MS = 10L * 60_000

private val nostrScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

/** @type {Map<String, number>} 网络域 nodeHash → lastSeenAt */
private val visibleByHash = LinkedHashMap<String, Long>()

/** @type {Map<String, Map<String, number>>} roomSecret → (nodeHash → lastSeenAt) */
private val visibleByGroup = LinkedHashMap<String, LinkedHashMap<String, Long>>()

private fun listPoolHashes(pool: LinkedHashMap<String, Long>, now: Long, ttlMs: Long): List<String> {
	val out = ArrayList<String>()
	val iterator = pool.entries.iterator()
	while (iterator.hasNext()) {
		val (hash, seenAt) = iterator.next()
		if (now - seenAt <= ttlMs) out.add(hash) else iterator.remove()
	}
	return out
}

/**
 * 写入网络域可见池（非群）。
 * @param nodeHash 节点 hash
 * @param now 当前时间
 */
@JvmOverloads
fun noteNostrVisibleNode(nodeHash: String?, now: Long = System.currentTimeMillis()) {
	val hash = isHex64(nodeHash) ?: return
	visibleByHash[hash] = now
}

/**
 * 写入群域可见池（与网络域隔离）。
 * @param roomSecret 房间密钥
 * @param nodeHash 节点 hash
 * @param now 当前时间
 */
@JvmOverloads
fun noteNostrGroupVisibleNode(roomSecret: String?, nodeHash: String?, now: Long = System.currentTimeMillis()) {
	val hash = isHex64(nodeHash) ?: return
	if (roomSecret.isNullOrEmpty()) return
	visibleByGroup.getOrPut(roomSecret) { LinkedHashMap() }[hash] = now
}

/**
 * @param now 当前时间
 * @param ttlMs TTL
 * @return 网络域可见 nodeHash
 */
@JvmOverloads
fun listNostrVisibleNodeHashes(now: Long = System.currentTimeMillis(), ttlMs: Long = ADVERT_TTL_MS): List<String> =
	listPoolHashes(visibleByHash, now, ttlMs)

/**
 * @param roomSecret 房间密钥
 * @param now 当前时间
 * @param ttlMs TTL
 * @return 该群可见 nodeHash
 */
@JvmOverloads
fun listNostrGroupVisibleNodeHashes(roomSecret: String?, now: Long = System.currentTimeMillis(), ttlMs: Long = ADVERT_TTL_MS): List<String> {
	val pool = visibleByGroup[roomSecret] ?: return emptyList()
	val out = listPoolHashes(pool, now, ttlMs)
	if (pool.isEmpty()) visibleByGroup.remove(roomSecret)
	return out
}

private suspend fun capturePeerRelayFields(verifiedNodeHash: String, listenRelays: List<String>, relayPool: List<Map<String, Any?>>) {
	if (isHex64(verifiedNodeHash) == null) return
	setPeerRoute(
		verifiedNodeHash,
		mapOf(
			"listenRelays" to listenRelays,
			"peerPool" to relayPool.map { linkedMapOf<String, Any?>("url" to it["url"], "rttMs" to it["rtt"]) },
		),
	)
	for (item in relayPool) {
		val url = item["url"]?.toString() ?: continue
		if (getPoolByUrl().containsKey(url)) continue
		if (!isRelayDestinationAllowed(url)) continue
		upsertRelay(mapOf("url" to url, "rttMs" to item["rtt"], "source" to "peer"))
		nostrScope.launch {
			runCatching { probeRelay(url) }
		}
	}
}

/**
 * 解密并验签后写入 Nostr 可见池；捕获对端 relay 字段到 peerRoutes。
 * @param rendezvousKey rendezvous 键
 * @param bytes 加密 advert
 * @param options 群池 / 本机回环过滤 / meta
 * @return 验签通过的 nodeHash
 */
@JvmOverloads
suspend fun acceptNostrAdvert(rendezvousKey: String, bytes: ByteArray, options: Map<String, Any?> = emptyMap()): String? {
	val ingested = ingestEncryptedAdvert(rendezvousKey, bytes) ?: return null
	val hash = ingested["verifiedNodeHash"] as String
	val skipHash = isHex64(options["skipNodeHash"])
	if (skipHash != null && skipHash == hash) return hash
	val roomSecret = options["roomSecret"]?.toString()
	var firstSeen: Boolean
	if (!roomSecret.isNullOrEmpty()) {
		firstSeen = visibleByGroup[roomSecret]?.containsKey(hash) != true
		noteNostrGroupVisibleNode(roomSecret, hash)
	}
	else {
		firstSeen = !visibleByHash.containsKey(hash)
		noteNostrVisibleNode(hash)
	}
	if (firstSeen) {
		noteDiscoveryPeerClue(hash)
		nodeDebug("p2p:nostr peer visible", linkedMapOf("peer" to shortHash(hash), "group" to !roomSecret.isNullOrEmpty()))
	}
	@Suppress("UNCHECKED_CAST")
	val listenRelays = ingested["listenRelays"] as List<String>
	@Suppress("UNCHECKED_CAST")
	val relayPool = ingested["relayPool"] as List<Map<String, Any?>>
	capturePeerRelayFields(hash, listenRelays, relayPool)
	@Suppress("UNCHECKED_CAST")
	val meta = options["meta"] as? Map<String, Any?> ?: emptyMap()
	@Suppress("UNCHECKED_CAST")
	noteAdvertPeerHints(hash, ingested["body"] as Map<String, Any?>?, meta)
	return hash
}

/** 测试用：清空 Nostr 可见池。 */
fun clearNostrVisibleNodes() {
	visibleByHash.clear()
	visibleByGroup.clear()
}

/**
 * 当前可用 nostr 中继。
 * @return relay URL 列表
 */
fun resolveNostrRelayUrls(): List<String> {
	val channels = getSignalingRuntimeConfig()["channels"] as? Map<*, *>
	val relay = (channels?.get("nostr") as? Map<*, *>)?.get("relay")
	if (relay is List<*> && relay.isNotEmpty()) return dedupeRelayUrls(relay.mapNotNull { it?.toString() })
	val configRelay = try {
		getNodeTransportSettings()["relayUrls"] as? List<*> ?: emptyList<Any?>()
	}
	catch (_: Exception) {
		emptyList<Any?>()
	}
	return if (configRelay.isNotEmpty()) dedupeRelayUrls(configRelay.mapNotNull { it?.toString() })
	else getListenRelays().map { it.url }
}

/**
 * 创建 Nostr discovery provider（list+connect；topic 仅内部）。
 * @param options 中继配置与本机 hash
 * @return Nostr discovery provider
 */
@JvmOverloads
fun createNostrDiscoveryProvider(options: Map<String, Any?> = emptyMap()): DiscoveryProvider {
	@Suppress("UNCHECKED_CAST")
	val explicitRelayUrls = options["relayUrls"] as? List<String>
	val getRelayUrls = options["getRelayUrls"] as? (() -> List<String>?)
	val hasExplicitRelay = explicitRelayUrls != null || getRelayUrls != null
	val releaseProviderTrustedRelays = explicitRelayUrls?.let { registerProviderTrustedRelayUrls(it) }

	fun resolveRelayUrlsLocal(): List<String> {
		if (getRelayUrls != null) return dedupeRelayUrls(getRelayUrls() ?: DEFAULT_RELAY_URLS)
		return if (explicitRelayUrls == null) resolveNostrRelayUrls() else dedupeRelayUrls(explicitRelayUrls)
	}

	var selfNodeHash: String? = isHex64(options["localNodeHash"])

	class AdvertSubEntry {
		var stop: () -> Unit = {}
		var held = false
		val listeners = LinkedHashSet<(ByteArray, Map<String, Any?>) -> Unit>()
	}

	val advertSubs = LinkedHashMap<String, AdvertSubEntry>()

	/** nodeHash → signal 订阅取消。 */
	val nodeSignalSubs = LinkedHashMap<String, () -> Unit>()

	/** 本轮 provider 生命周期内追加的中继订阅取消。 */
	val extraSubs = ArrayList<() -> Unit>()

	/** 本 provider 实例专用的 Schnorr 事件签名私钥（等价 JS `randomBytes(32)`）。 */
	val secretKey = randomBytes(32)

	fun noteSelfNodeHash(nodeHash: String?) {
		val hash = isHex64(nodeHash) ?: return
		selfNodeHash = hash
	}

	fun releaseAdvertEntryIfIdle(key: String, entry: AdvertSubEntry) {
		if (entry.held || entry.listeners.isNotEmpty()) return
		try {
			entry.stop()
		}
		catch (_: Exception) {
			// ignore
		}
		advertSubs.remove(key)
	}

	fun ensureAdvertSubscription(
		key: String,
		rendezvousKey: String,
		roomSecret: String?,
		listener: ((ByteArray, Map<String, Any?>) -> Unit)?,
	): () -> Unit {
		var entry = advertSubs[key]
		if (entry == null) {
			val created = AdvertSubEntry()
			created.stop = subscribeNostrKind(
				resolveRelayUrlsLocal(),
				kind = NOSTR_ADVERT_KIND,
				rendezvousKey = rendezvousKey,
				tagX = "advert",
				addressable = true,
				onPayload = { bytes, meta ->
					nostrScope.launch {
						acceptNostrAdvert(
							rendezvousKey,
							bytes,
							linkedMapOf("roomSecret" to roomSecret, "skipNodeHash" to selfNodeHash, "meta" to meta),
						)
						for (fn in created.listeners) try {
							fn(bytes, meta)
						}
						catch (_: Exception) {
							// ignore
						}
					}
				},
				resolveConnectTarget = { url -> resolveRelayConnectTarget(url) },
			)
			entry = created
			advertSubs[key] = created
		}
		val current = entry
		if (listener == null) {
			current.held = true
			return {}
		}
		current.listeners.add(listener)
		return {
			current.listeners.remove(listener)
			releaseAdvertEntryIfIdle(key, current)
		}
	}

	fun ensureNetworkAdvertSubscription(): () -> Unit =
		ensureAdvertSubscription("network", networkRendezvousKey(), null, null)

	fun ensureGroupSubscription(roomSecret: String, listener: ((ByteArray, Map<String, Any?>) -> Unit)? = null): () -> Unit =
		ensureAdvertSubscription("group:$roomSecret", groupRendezvousKey(roomSecret), roomSecret, listener)

	return object : DiscoveryProvider("nostr", 100.0) {
		override val caps: Map<String, Any?> = mapOf("canDiscover" to true, "canSignal" to true, "canRelay" to false)

		override suspend fun listVisibleNodeHashes(options: Map<String, Any?>): List<String> {
			val limit = maxOf(1, (options["limit"] as? Number)?.toInt() ?: 64)
			val roomSecret = options["roomSecret"]?.toString()
			if (!roomSecret.isNullOrEmpty()) {
				ensureGroupSubscription(roomSecret)
				return listNostrGroupVisibleNodeHashes(roomSecret).filter { it != selfNodeHash }.take(limit)
			}
			ensureNetworkAdvertSubscription()
			return listNostrVisibleNodeHashes().filter { it != selfNodeHash }.take(limit)
		}

		override suspend fun connectToNode(nodeHash: String, options: Map<String, Any?>): Boolean {
			val hash = isHex64(nodeHash) ?: return false
			ensureAdvertSubscription("node:$hash", nodeRendezvousKey(hash), null, null)
			return true
		}

		override suspend fun watchNodeAdvert(nodeHash: String, onAdvert: (ByteArray, Map<String, Any?>) -> Unit): (() -> Unit)? {
			val hash = isHex64(nodeHash) ?: throw IllegalArgumentException("nostr: invalid nodeHash")
			return ensureAdvertSubscription("node:$hash", nodeRendezvousKey(hash), null, onAdvert)
		}

		override suspend fun watchGroupAdverts(roomSecret: String, onAdvert: (ByteArray, Map<String, Any?>) -> Unit): (() -> Unit)? =
			ensureGroupSubscription(roomSecret, onAdvert)

		override suspend fun sendNodeSignal(toNodeHash: String, bytes: ByteArray): Boolean? {
			val hash = isHex64(toNodeHash) ?: throw IllegalArgumentException("nostr: invalid nodeHash")
			val rendezvousKey = nodeRendezvousKey(hash)
			val event = signNostrEvent(
				NOSTR_SIGNAL_KIND,
				listOf(NOSTR_TOPIC_TAG, listOf("t", rendezvousKey), listOf("x", "signal"), listOf("p", hash)),
				bytesToBase64(bytes),
				secretKey,
			)
			// 有显式 relay 配置（测试/用户 pin）时直接全量发布，否则走路由。
			if (hasExplicitRelay) {
				publishEvent(resolveRelayUrlsLocal(), event)
				return true
			}
			routePublishEvent(hash, event)
			return true
		}

		override suspend fun listenNodeSignals(
			localNodeHash: String,
			onSignal: (ByteArray) -> Unit,
		): (() -> Unit)? {
			val hash = isHex64(localNodeHash) ?: throw IllegalArgumentException("nostr: invalid nodeHash")
			noteSelfNodeHash(hash)
			val rendezvousKey = nodeRendezvousKey(hash)
			nodeSignalSubs[hash]?.invoke()
			nodeDebug(
				"p2p:nostr signal listen",
				linkedMapOf("self" to shortHash(hash), "relays" to resolveRelayUrlsLocal().size.toDouble()),
			)
			val stop = subscribeNostrKind(
				resolveRelayUrlsLocal(),
				kind = NOSTR_SIGNAL_KIND,
				rendezvousKey = rendezvousKey,
				tagX = "signal",
				onPayload = { bytes, _ -> onSignal(bytes) },
				resolveConnectTarget = { url -> resolveRelayConnectTarget(url) },
			)
			nodeSignalSubs[hash] = stop
			return {
				stop()
				nodeSignalSubs.remove(hash)
			}
		}

		override suspend fun startPresence(getBeacon: suspend () -> Map<String, Any?>?): (() -> Unit)? {
			val rendezvousKey = networkRendezvousKey()
			val signal = AbortSignalLike()
			var stopped = false
			ensureNetworkAdvertSubscription()
			val tags = listOf(
				NOSTR_TOPIC_TAG,
				listOf("t", rendezvousKey),
				listOf("x", "advert"),
				listOf("d", rendezvousKey),
			)
			suspend fun publish() {
				if (stopped || signal.aborted) return
				val beacon = getBeacon() ?: return
				val nodeHash = beacon["nodeHash"]?.toString()
				if (nodeHash.isNullOrEmpty()) return
				noteSelfNodeHash(nodeHash)
				val body = beacon["advertBody"] ?: beacon["body"] ?: beacon
				val event = signNostrEvent(
					NOSTR_ADVERT_KIND,
					tags,
					bytesToBase64(encryptSignalPacket(rendezvousKey, linkedMapOf("type" to "advert", "body" to body))),
					secretKey,
				)
				publishEvent(resolveRelayUrlsLocal(), event, signal)
				nodeDebug("p2p:nostr presence published", linkedMapOf("self" to shortHash(nodeHash)))
			}
			val job = nostrScope.launch {
				while (true) {
					try {
						publish()
					}
					catch (error: Throwable) {
						nodeDebug("p2p:nostr presence publish fail", linkedMapOf("err" to (error.message ?: error.toString())))
					}
					delay(5 * 60_000)
				}
			}
			val census = createNostrCensus(
				NostrCensusDeps(
					resolveRelayUrls = { resolveRelayUrlsLocal() },
					publishEvent = { urls, event, sig -> publishEvent(urls, event, sig) },
					signEvent = { kind, tagsIn, content -> signNostrEvent(kind, tagsIn, content, secretKey) },
				),
			)
			census.start()
			return {
				stopped = true
				signal.abort()
				job.cancel()
				census.stop()
			}
		}

		override suspend fun startGroupPresence(
			roomSecret: String,
			getBeacon: suspend () -> Map<String, Any?>?,
		): (() -> Unit)? {
			val rendezvousKey = groupRendezvousKey(roomSecret)
			val signal = AbortSignalLike()
			var stopped = false
			ensureGroupSubscription(roomSecret)
			val tags = listOf(
				NOSTR_TOPIC_TAG,
				listOf("t", rendezvousKey),
				listOf("x", "advert"),
				listOf("d", rendezvousKey),
			)
			suspend fun publish() {
				if (stopped || signal.aborted) return
				val beacon = getBeacon() ?: return
				val nodeHash = beacon["nodeHash"]?.toString()
				if (nodeHash.isNullOrEmpty()) return
				noteSelfNodeHash(nodeHash)
				val body = beacon["advertBody"] ?: beacon["body"] ?: beacon
				val event = signNostrEvent(
					NOSTR_ADVERT_KIND,
					tags,
					bytesToBase64(encryptSignalPacket(rendezvousKey, linkedMapOf("type" to "advert", "body" to body))),
					secretKey,
				)
				publishEvent(resolveRelayUrlsLocal(), event, signal)
			}
			val job = nostrScope.launch {
				while (true) {
					try {
						publish()
					}
					catch (_: Throwable) {
						// ignore
					}
					delay(5 * 60_000)
				}
			}
			return {
				stopped = true
				signal.abort()
				job.cancel()
			}
		}

		override fun noteVisibleNode(nodeHash: String, options: Map<String, Any?>) {
			val roomSecret = options["roomSecret"]?.toString()
			if (!roomSecret.isNullOrEmpty()) noteNostrGroupVisibleNode(roomSecret, nodeHash)
			else noteNostrVisibleNode(nodeHash)
		}

		override fun dispose() {
			releaseProviderTrustedRelays?.invoke()
			for (entry in advertSubs.values.toList()) try {
				entry.stop()
			}
			catch (_: Exception) {
				// ignore
			}
			advertSubs.clear()
			for (stop in nodeSignalSubs.values.toList()) try {
				stop()
			}
			catch (_: Exception) {
				// ignore
			}
			nodeSignalSubs.clear()
			for (stop in extraSubs.toList()) try {
				stop()
			}
			catch (_: Exception) {
				// ignore
			}
			extraSubs.clear()
		}
	}
}
