package io.github.steve02081504.fountp2p.discovery.nostr

import io.github.steve02081504.fountp2p.core.bytesToBase64
import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.discovery.DiscoveryProvider
import io.github.steve02081504.fountp2p.discovery.ingestEncryptedAdvert
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
 * 签名 Nostr 事件。
 *
 * **未移植（deferred）**：BIP340 Schnorr 签名未在 Kotlin 侧实现，调用即抛
 * `UnsupportedOperationException`。可见池/验签/订阅路径不受影响。
 * @return 永不返回
 */
private fun signNostrEvent(): Nothing =
	throw UnsupportedOperationException("p2p: nostr schnorr signing not ported (deferred)")

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
			// 需要 Schnorr 签名（deferred）。
			signNostrEvent()
			return null
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
		}
	}
}
