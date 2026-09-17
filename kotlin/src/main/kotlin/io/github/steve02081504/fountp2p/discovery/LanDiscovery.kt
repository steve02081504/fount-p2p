package io.github.steve02081504.fountp2p.discovery

import io.github.steve02081504.fountp2p.core.base64ToBytes
import io.github.steve02081504.fountp2p.core.bytesToBase64
import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.node.nodeDebug
import io.github.steve02081504.fountp2p.node.shortHash
import kotlinx.coroutines.launch

private const val DEFAULT_PORT = 53531
private const val DEFAULT_GROUP = "239.255.42.99"
private const val BEACON_INTERVAL_MS = 30_000L

/** UDP 组播 socket 抽象（Android/JVM 无 `node:dgram`；由宿主注入）。 */
interface UdpSocket {
	/** 入站包回调（载荷 + 来源地址）。 */
	var onMessage: ((ByteArray, String) -> Unit)?

	/**
	 * @param addresses 本机出口地址
	 * @param group 组播组
	 */
	suspend fun joinMemberships(addresses: List<String>, group: String)

	/**
	 * @param ttl 组播 TTL
	 */
	fun setMulticastTtl(ttl: Int)

	/**
	 * @param bytes 载荷
	 * @param port 目标端口
	 * @param group 组播组
	 * @param iface 出口地址
	 */
	suspend fun send(bytes: ByteArray, port: Int, group: String, iface: String?)

	/** 关闭 socket。 */
	fun close()
}

/** UDP 组播 socket 工厂。 */
interface UdpSocketProvider {
	/**
	 * 打开复用地址的 udp4 socket。
	 * @return socket
	 */
	suspend fun open(): UdpSocket
}

private var udpSocketProvider: UdpSocketProvider? = null

/** @param provider UDP socket 工厂 */
fun setUdpSocketProvider(provider: UdpSocketProvider?) {
	udpSocketProvider = provider
}

/** @type {Map<String, number>} nodeHash → lastSeenAt */
private val visibleByHash = LinkedHashMap<String, Long>()

/**
 * 记入 LAN 可见池。
 * @param nodeHash 节点 hash
 * @param now 当前时间
 */
@JvmOverloads
fun noteLanVisibleNode(nodeHash: String?, now: Long = System.currentTimeMillis()) {
	val hash = isHex64(nodeHash) ?: return
	visibleByHash[hash] = now
}

/**
 * 列出未过期的 LAN 可见 nodeHash。
 * @param now 当前时间
 * @param ttlMs TTL
 * @return 可见 nodeHash 列表
 */
@JvmOverloads
fun listLanVisibleNodeHashes(now: Long = System.currentTimeMillis(), ttlMs: Long = BEACON_INTERVAL_MS * 3): List<String> {
	val out = ArrayList<String>()
	val iterator = visibleByHash.entries.iterator()
	while (iterator.hasNext()) {
		val (hash, seenAt) = iterator.next()
		if (now - seenAt <= ttlMs) out.add(hash) else iterator.remove()
	}
	return out
}

/** 测试用：清空 LAN 可见池。 */
fun clearLanVisibleNodes() = visibleByHash.clear()

/**
 * Untrusted ingress：验签 network advert 后写入可见池 / peer hint。
 * @param advertBytes 加密 network advert
 * @param meta 发送方地址 / 本机 nodeHash（过滤自回环）
 * @return 验签结果
 */
@JvmOverloads
fun acceptLanPresenceAdvert(advertBytes: ByteArray?, meta: Map<String, Any?> = emptyMap()): Map<String, Any?>? {
	if (advertBytes == null || advertBytes.isEmpty()) return null
	val ingested = ingestNetworkAdvert(advertBytes) ?: return null
	val hash = ingested["verifiedNodeHash"] as String
	val skipHash = isHex64(meta["skipNodeHash"])
	if (skipHash != null && hash == skipHash) return ingested
	val firstSeen = !visibleByHash.containsKey(hash)
	noteLanVisibleNode(hash)
	@Suppress("UNCHECKED_CAST")
	noteAdvertPeerHints(hash, ingested["body"] as Map<String, Any?>?, meta)
	if (firstSeen) {
		noteDiscoveryPeerClue(hash)
		val host = meta["address"]?.toString() ?: ""
		nodeDebug(
			"p2p:lan peer visible",
			linkedMapOf("peer" to shortHash(hash), "host" to host.ifEmpty { null }, "tcpPort" to (ingested["body"] as? Map<*, *>)?.get("tcpPort")),
		)
	}
	return ingested
}

/**
 * LAN UDP presence：段内 beacon，非 topic 订阅模型。
 * @param options 配置
 * @return LAN 发现提供者
 */
@JvmOverloads
fun createLanDiscoveryProvider(options: Map<String, Any?> = emptyMap()): DiscoveryProvider {
	val port = (options["port"] as? Number)?.toInt() ?: DEFAULT_PORT
	val group = options["group"] as? String ?: DEFAULT_GROUP
	var socket: UdpSocket? = null
	var beaconJob: kotlinx.coroutines.Job? = null
	var selfNodeHash: String? = isHex64(options["localNodeHash"])
	val scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Default)

	suspend fun getSocket(): UdpSocket {
		socket?.let { return it }
		val provider = udpSocketProvider ?: throw IllegalStateException("p2p: lan udp provider unavailable")
		val created = provider.open()
		created.onMessage = { raw, address ->
			val packet = try {
				io.github.steve02081504.fountp2p.core.Json.parse(String(raw, Charsets.UTF_8)) as? Map<*, *>
			}
			catch (_: Exception) {
				null
			}
			if (packet?.get("type") == "presence") {
				val advertBytes = try {
					(packet["advertBytes"] as? String)?.let { base64ToBytes(it) }
				}
				catch (_: Exception) {
					null
				}
				if (advertBytes != null && advertBytes.isNotEmpty())
					acceptLanPresenceAdvert(
						advertBytes,
						linkedMapOf("address" to address, "provider" to "lan", "skipNodeHash" to selfNodeHash),
					)
			}
		}
		socket = created
		return created
	}

	return object : DiscoveryProvider("lan", 10.0) {
		override val caps: Map<String, Any?> = mapOf("canDiscover" to true, "canSignal" to false, "canRelay" to false)

		override suspend fun listVisibleNodeHashes(options: Map<String, Any?>): List<String> {
			if (options["roomSecret"] != null) return emptyList()
			val limit = maxOf(1, (options["limit"] as? Number)?.toInt() ?: 64)
			return listLanVisibleNodeHashes().take(limit)
		}

		override suspend fun connectToNode(nodeHash: String, options: Map<String, Any?>): Boolean =
			getLanPeerHint(nodeHash) != null

		override suspend fun startPresence(getBeacon: suspend () -> Map<String, Any?>?): () -> Unit {
			val sock = getSocket()
			suspend fun send() {
				val body = getBeacon() ?: return
				val hash = body["nodeHash"]?.toString()
				if (!hash.isNullOrEmpty()) selfNodeHash = hash
				val advertBytes = body["advertBytes"] as? ByteArray
				if (advertBytes == null || advertBytes.isEmpty()) return
				val packet = linkedMapOf<String, Any?>(
					"type" to "presence",
					"nodeHash" to hash,
					"tcpPort" to body["tcpPort"],
					"advertBytes" to bytesToBase64(advertBytes),
				)
				val bytes = (io.github.steve02081504.fountp2p.core.Json.stringify(packet) ?: "null").toByteArray(Charsets.UTF_8)
				val addrs = listMulticastIpv4Addresses()
				if (addrs.isEmpty()) {
					sock.send(bytes, port, group, null)
					return
				}
				var sent = 0
				var lastError: Exception? = null
				for (addr in addrs) try {
					sock.send(bytes, port, group, addr)
					sent++
				}
				catch (error: Exception) {
					lastError = error
				}
				if (sent == 0) throw lastError ?: IllegalStateException("p2p: lan multicast send failed")
			}
			beaconJob = scope.launch {
				runCatching { send() }
				while (true) {
					kotlinx.coroutines.delay(BEACON_INTERVAL_MS)
					runCatching { send() }
				}
			}
			return {
				beaconJob?.cancel()
				beaconJob = null
				selfNodeHash = null
				socket?.let { runCatching { it.close() } }
				socket = null
			}
		}
	}
}
