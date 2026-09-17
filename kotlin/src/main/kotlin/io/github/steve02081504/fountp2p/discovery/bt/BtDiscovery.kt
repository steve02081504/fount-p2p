package io.github.steve02081504.fountp2p.discovery.bt

import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.discovery.DiscoveryProvider
import io.github.steve02081504.fountp2p.discovery.ingestNetworkAdvert
import io.github.steve02081504.fountp2p.discovery.noteAdvertPeerHints
import io.github.steve02081504.fountp2p.discovery.noteDiscoveryPeerClue
import io.github.steve02081504.fountp2p.node.nodeDebug
import io.github.steve02081504.fountp2p.node.shortHash
import kotlinx.coroutines.launch

private const val PERIPHERAL_RESCAN_MS = 15_000L

/** @type {Map<String, number>} nodeHash → lastSeenAt */
private val visibleByHash = LinkedHashMap<String, Long>()

/**
 * @param nodeHash 节点 hash
 * @param now 当前时间
 */
@JvmOverloads
fun noteBtVisibleNode(nodeHash: String?, now: Long = System.currentTimeMillis()) {
	val hash = isHex64(nodeHash) ?: return
	visibleByHash[hash] = now
}

/**
 * @param now 当前时间
 * @param ttlMs TTL
 * @return 可见 nodeHash
 */
@JvmOverloads
fun listBtVisibleNodeHashes(now: Long = System.currentTimeMillis(), ttlMs: Long = PERIPHERAL_RESCAN_MS * 4): List<String> {
	val out = ArrayList<String>()
	val iterator = visibleByHash.entries.iterator()
	while (iterator.hasNext()) {
		val (hash, seenAt) = iterator.next()
		if (now - seenAt <= ttlMs) out.add(hash) else iterator.remove()
	}
	return out
}

/** 测试用：清空 BT 可见池。 */
fun clearBtVisibleNodes() = visibleByHash.clear()

/**
 * 扫描到的 BT presence：验签 network advert 后写入可见池与 peer hint。
 * @param bytes 加密 network advert
 * @param meta 扫描 meta（至少 peripheralId）
 * @return 验签结果
 */
fun acceptBtScannedPresence(bytes: ByteArray?, meta: Map<String, Any?>?): Map<String, Any?>? {
	val peripheralId = meta?.get("peripheralId")?.toString() ?: ""
	if (peripheralId.isEmpty() || bytes == null || bytes.isEmpty()) return null
	val ingested = ingestNetworkAdvert(bytes) ?: return null
	val hash = ingested["verifiedNodeHash"] as String
	val firstSeen = !visibleByHash.containsKey(hash)
	noteBtVisibleNode(hash)
	@Suppress("UNCHECKED_CAST")
	noteAdvertPeerHints(hash, ingested["body"] as Map<String, Any?>?, meta)
	if (firstSeen) {
		noteDiscoveryPeerClue(hash)
		nodeDebug("p2p:bt peer visible", linkedMapOf("peer" to shortHash(hash), "peripheralId" to peripheralId))
	}
	return ingested
}

/**
 * Bluetooth 发现提供者：固定 GATT service 传 presence / node signal，无 topic。
 * @return Bluetooth 发现提供者
 */
fun createBluetoothDiscoveryProvider(): DiscoveryProvider {
	val role = resolveBtRole()
	val signalListeners = LinkedHashMap<String, MutableSet<(ByteArray) -> Unit>>()
	var localNodeHash: String? = null
	val scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Default)

	suspend fun sendNodeSignalViaGatt(toNodeHash: String, bytes: ByteArray): Boolean {
		val hint = getBtPeerHint(toNodeHash) ?: return false
		val provider = getBluetoothProvider() ?: return false
		return try {
			provider.sendSignal(hint.peripheralId, bytes)
		}
		catch (_: Exception) {
			false
		}
	}

	return object : DiscoveryProvider("bt", 20.0) {
		override val caps: Map<String, Any?> = mapOf("canDiscover" to true, "canSignal" to true, "canRelay" to false)

		override suspend fun listVisibleNodeHashes(options: Map<String, Any?>): List<String> {
			if (options["roomSecret"] != null) return emptyList()
			val limit = maxOf(1, (options["limit"] as? Number)?.toInt() ?: 64)
			return listBtVisibleNodeHashes().take(limit)
		}

		override suspend fun connectToNode(nodeHash: String, options: Map<String, Any?>): Boolean {
			val hash = isHex64(nodeHash) ?: return false
			if (getBtPeerHint(hash) == null) return false
			return sendNodeSignalViaGatt(hash, ByteArray(1))
		}

		override suspend fun startPresence(getBeacon: suspend () -> Map<String, Any?>?): () -> Unit {
			if (role == "scan") return {}
			suspend fun refresh() {
				val body = getBeacon() ?: return
				val hash = isHex64(body["nodeHash"]) ?: return
				localNodeHash = hash
				noteBtVisibleNode(hash)
			}
			runCatching { refresh() }
			val job = scope.launch {
				while (true) {
					kotlinx.coroutines.delay(30_000)
					runCatching { refresh() }
				}
			}
			return {
				job.cancel()
				localNodeHash = null
			}
		}

		override suspend fun sendNodeSignal(toNodeHash: String, bytes: ByteArray): Boolean {
			val ok = sendNodeSignalViaGatt(toNodeHash, bytes)
			if (!ok) throw IllegalStateException("p2p: bt signal unavailable")
			return true
		}

		override suspend fun listenNodeSignals(localNodeHash: String, onSignal: (ByteArray) -> Unit): () -> Unit {
			if (role == "scan") return {}
			val hash = isHex64(localNodeHash) ?: throw IllegalArgumentException("p2p: invalid nodeHash")
			signalListeners.getOrPut(hash) { LinkedHashSet() }.add(onSignal)
			return {
				signalListeners[hash]?.remove(onSignal)
				Unit
			}
		}
	}
}
