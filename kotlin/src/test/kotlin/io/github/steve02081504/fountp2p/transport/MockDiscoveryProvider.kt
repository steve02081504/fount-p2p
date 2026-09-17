package io.github.steve02081504.fountp2p.transport

import io.github.steve02081504.fountp2p.discovery.DiscoveryProvider

/**
 * 测试用 discovery provider（list+connect API），等价 `js/test/helpers/mock_discovery.mjs`。
 *
 * 偏离：JS 用 `setInterval` 周期性广播 presence；Kotlin 只广播一次，测试无需真实定时器。
 */
class MockDiscoveryProvider(id: String = "mock-discovery") : DiscoveryProvider(id, 1.0) {
	private val advertsByNode = LinkedHashMap<String, ByteArray>()
	private val advertListeners = LinkedHashMap<String, MutableSet<(ByteArray, Map<String, Any?>) -> Unit>>()
	private val groupAdvertListeners = LinkedHashMap<String, MutableSet<(ByteArray, Map<String, Any?>) -> Unit>>()
	private val signalListeners = LinkedHashMap<String, MutableSet<(ByteArray) -> Unit>>()
	private val visible = LinkedHashSet<String>()
	private val visibleByGroup = LinkedHashMap<String, MutableSet<String>>()

	/** 记录 [watchGroupAdverts] 订阅过的 roomSecret（供重订阅断言）。 */
	val watchedGroupSecrets = ArrayList<String>()

	/**
	 * @param nodeHash 节点 hash
	 * @param bytes advert 字节
	 */
	fun publishAdvert(nodeHash: String, bytes: ByteArray) {
		advertsByNode[nodeHash] = bytes
		visible.add(nodeHash)
		for (listener in advertListeners[nodeHash].orEmpty().toList()) listener(bytes, mapOf("provider" to id))
	}

	/**
	 * @param roomSecret 房间密钥
	 * @param nodeHash 节点 hash
	 * @param bytes advert 字节
	 */
	fun publishGroupAdvert(roomSecret: String, nodeHash: String, bytes: ByteArray) {
		val key = roomSecret
		visibleByGroup.getOrPut(key) { LinkedHashSet() }.add(nodeHash)
		for (listener in groupAdvertListeners[key].orEmpty().toList()) listener(bytes, mapOf("provider" to id))
	}

	override suspend fun listVisibleNodeHashes(options: Map<String, Any?>): List<String> {
		val limit = maxOf(1, (options["limit"] as? Number)?.toInt() ?: 64)
		val roomSecret = options["roomSecret"] as? String
		return if (!roomSecret.isNullOrEmpty()) visibleByGroup[roomSecret].orEmpty().take(limit)
		else visible.toList().take(limit)
	}

	override suspend fun connectToNode(nodeHash: String, options: Map<String, Any?>): Boolean = visible.contains(nodeHash)

	override suspend fun startPresence(getBeacon: suspend () -> Map<String, Any?>?): () -> Unit {
		val beacon = getBeacon()
		val nodeHash = beacon?.get("nodeHash")?.toString()
		if (!nodeHash.isNullOrEmpty()) {
			val bytes = beacon["advertBytes"] as? ByteArray ?: byteArrayOf(1)
			publishAdvert(nodeHash, bytes)
		}
		return { }
	}

	override suspend fun startGroupPresence(
		roomSecret: String,
		getBeacon: suspend () -> Map<String, Any?>?,
	): () -> Unit {
		val beacon = getBeacon()
		val nodeHash = beacon?.get("nodeHash")?.toString()
		if (!nodeHash.isNullOrEmpty()) {
			val bytes = beacon["advertBytes"] as? ByteArray ?: byteArrayOf(1)
			publishGroupAdvert(roomSecret, nodeHash, bytes)
			visible.add(nodeHash)
		}
		return { }
	}

	override fun noteVisibleNode(nodeHash: String, options: Map<String, Any?>) {
		val roomSecret = options["roomSecret"] as? String
		if (!roomSecret.isNullOrEmpty()) {
			visibleByGroup.getOrPut(roomSecret) { LinkedHashSet() }.add(nodeHash)
			return
		}
		visible.add(nodeHash)
	}

	override suspend fun sendNodeSignal(toNodeHash: String, bytes: ByteArray): Boolean {
		for (listener in signalListeners[toNodeHash].orEmpty().toList()) listener(bytes)
		return true
	}

	override suspend fun listenNodeSignals(
		localNodeHash: String,
		onSignal: (ByteArray) -> Unit,
	): () -> Unit {
		val set = signalListeners.getOrPut(localNodeHash) { LinkedHashSet() }
		set.add(onSignal)
		return { set.remove(onSignal); Unit }
	}

	override suspend fun watchNodeAdvert(
		nodeHash: String,
		onAdvert: (ByteArray, Map<String, Any?>) -> Unit,
	): () -> Unit {
		val set = advertListeners.getOrPut(nodeHash) { LinkedHashSet() }
		set.add(onAdvert)
		advertsByNode[nodeHash]?.let { onAdvert(it, mapOf("provider" to id)) }
		return { set.remove(onAdvert); Unit }
	}

	override suspend fun watchGroupAdverts(
		roomSecret: String,
		onAdvert: (ByteArray, Map<String, Any?>) -> Unit,
	): () -> Unit {
		watchedGroupSecrets.add(roomSecret)
		val set = groupAdvertListeners.getOrPut(roomSecret) { LinkedHashSet() }
		set.add(onAdvert)
		return { set.remove(onAdvert); Unit }
	}
}
