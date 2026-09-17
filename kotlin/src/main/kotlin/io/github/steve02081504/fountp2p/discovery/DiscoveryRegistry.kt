package io.github.steve02081504.fountp2p.discovery

import io.github.steve02081504.fountp2p.discovery.internal.decryptSignalPacket
import io.github.steve02081504.fountp2p.discovery.internal.encryptSignalPacket
import io.github.steve02081504.fountp2p.discovery.internal.nodeRendezvousKey
import io.github.steve02081504.fountp2p.node.nodeDebug
import io.github.steve02081504.fountp2p.node.shortHash
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * discovery 提供者（平台抽象）。
 *
 * 与 JS 不同：Kotlin 无方法存在性探测，未实现的方法返回 null 表示「不支持」。
 */
open class DiscoveryProvider(val id: String, val priority: Double) {
	/** 能力声明（可选）。 */
	open val caps: Map<String, Any?>? = null

	/**
	 * @param options 扫描选项
	 * @return 可见 nodeHash 列表；null 表示不支持
	 */
	open suspend fun listVisibleNodeHashes(options: Map<String, Any?>): List<String>? = null

	/**
	 * @param nodeHash 目标
	 * @param options 额外选项
	 * @return 是否已准备；null 表示不支持
	 */
	open suspend fun connectToNode(nodeHash: String, options: Map<String, Any?> = emptyMap()): Boolean? = null

	/**
	 * @param getBeacon 本机 beacon 工厂
	 * @return 停止函数；null 表示不支持
	 */
	open suspend fun startPresence(getBeacon: suspend () -> Map<String, Any?>?): (() -> Unit)? = null

	/**
	 * @param roomSecret 房间密钥
	 * @param getBeacon 本机 beacon 工厂
	 * @return 停止函数；null 表示不支持
	 */
	open suspend fun startGroupPresence(roomSecret: String, getBeacon: suspend () -> Map<String, Any?>?): (() -> Unit)? = null

	/**
	 * @param toNodeHash 目标 nodeHash
	 * @param bytes 载荷
	 * @return 是否发送成功（false 失败）；null 表示不支持
	 */
	open suspend fun sendNodeSignal(toNodeHash: String, bytes: ByteArray): Boolean? = null

	/**
	 * @param localNodeHash 本机 nodeHash
	 * @param onSignal 回调
	 * @return 取消函数；null 表示不支持
	 */
	open suspend fun listenNodeSignals(localNodeHash: String, onSignal: (ByteArray) -> Unit): (() -> Unit)? = null

	/**
	 * @param nodeHash 目标 nodeHash
	 * @param onAdvert 回调
	 * @return 取消函数；null 表示不支持
	 */
	open suspend fun watchNodeAdvert(nodeHash: String, onAdvert: (ByteArray, Map<String, Any?>) -> Unit): (() -> Unit)? = null

	/**
	 * @param roomSecret 房间密钥
	 * @param onAdvert 回调
	 * @return 取消函数；null 表示不支持
	 */
	open suspend fun watchGroupAdverts(roomSecret: String, onAdvert: (ByteArray, Map<String, Any?>) -> Unit): (() -> Unit)? = null

	/**
	 * @param nodeHash 节点 hash
	 * @param options 带 roomSecret 时写入群池
	 */
	open fun noteVisibleNode(nodeHash: String, options: Map<String, Any?>) {}

	/** 释放资源。 */
	open fun dispose() {}
}

private val providers = LinkedHashMap<String, DiscoveryProvider>()

private val discoveryScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

private var linkDialer: (suspend (String) -> Any?)? = null

/**
 * 由 link registry 注入：discovery.connectToNode 经此建链。
 * @param dialer 拨号函数
 */
fun setDiscoveryLinkDialer(dialer: (suspend (String) -> Any?)?) {
	linkDialer = dialer
}

/**
 * @param provider 发现提供者
 * @return 注销函数
 */
fun registerDiscoveryProvider(provider: DiscoveryProvider): () -> Unit {
	if (provider.id.isEmpty()) throw IllegalArgumentException("p2p: discovery provider requires id")
	providers[provider.id] = provider
	return { unregisterDiscoveryProvider(provider.id) }
}

/**
 * @param id 提供者 id
 */
fun unregisterDiscoveryProvider(id: String) {
	val provider = providers.remove(id)
	try {
		provider?.dispose()
	}
	catch (_: Exception) {
		// ignore
	}
}

/** 清空全部 provider。 */
fun clearDiscoveryProviders() {
	val list = providers.values.toList()
	providers.clear()
	for (provider in list) try {
		provider.dispose()
	}
	catch (_: Exception) {
		// ignore
	}
}

/** @return 按 priority 升序排列的已注册提供者 */
fun listDiscoveryProviders(): List<DiscoveryProvider> = providers.values.sortedBy { it.priority }

/**
 * @param id 提供者 id
 * @return 对应 provider，未注册为 null
 */
fun getDiscoveryProvider(id: String): DiscoveryProvider? = providers[id]

/**
 * 合并各 provider 可见 nodeHash。
 * @param options 扫描选项
 * @return 去重后的 nodeHash 列表
 */
suspend fun listVisibleNodeHashes(options: Map<String, Any?> = emptyMap()): List<String> {
	val limit = maxOf(1, (options["limit"] as? Number)?.toInt() ?: 64)
	val seen = LinkedHashSet<String>()
	val byProvider = LinkedHashMap<String, Any?>()
	for (provider in listDiscoveryProviders()) {
		try {
			val hashes = provider.listVisibleNodeHashes(options) ?: continue
			byProvider[provider.id] = hashes.map { shortHash(it) }
			for (hash in hashes) {
				if (hash.isNotEmpty()) seen.add(hash)
				if (seen.size >= limit) break
			}
			if (seen.size >= limit) break
		}
		catch (error: Exception) {
			nodeDebug("p2p:discovery list fail", linkedMapOf("provider" to provider.id, "err" to (error.message ?: error.toString())))
		}
	}
	val out = seen.toList().take(limit)
	nodeDebug("p2p:discovery visible", linkedMapOf("total" to out.size.toDouble(), "group" to (options["roomSecret"] != null), "byProvider" to byProvider))
	return out
}

/**
 * 各发现介质准备通往 nodeHash 的路径（hint / 订阅 / 近场），不建链。
 * @param nodeHash 目标 nodeHash
 * @param options 额外选项
 */
suspend fun prepareConnectToNode(nodeHash: String, options: Map<String, Any?> = emptyMap()) {
	for (provider in listDiscoveryProviders()) {
		try {
			provider.connectToNode(nodeHash, options)
		}
		catch (_: Exception) {
			// prepare next medium
		}
	}
}

/**
 * 经 registry dialer 建链（dialer 内 prepare）；无 dialer 时仅 prepare，返回 false。
 * @param nodeHash 目标 nodeHash
 * @param options 无 dialer 时转交 prepare
 * @return 是否建链成功
 */
suspend fun connectToNode(nodeHash: String, options: Map<String, Any?> = emptyMap()): Boolean {
	val dialer = linkDialer
	if (dialer == null) {
		prepareConnectToNode(nodeHash, options)
		nodeDebug("p2p:discovery connect skip", linkedMapOf("peer" to shortHash(nodeHash), "reason" to "no-dialer"))
		return false
	}
	return try {
		val result = dialer(nodeHash)
		val ok = result != null && result != false
		nodeDebug(if (ok) "p2p:discovery connect ok" else "p2p:discovery connect miss", linkedMapOf("peer" to shortHash(nodeHash)))
		ok
	}
	catch (error: Exception) {
		nodeDebug("p2p:discovery connect fail", linkedMapOf("peer" to shortHash(nodeHash), "err" to (error.message ?: error.toString())))
		false
	}
}

/**
 * 经各可信令介质发送；任一成功即返回。
 * @param toNodeHash 目标 nodeHash
 * @param bytes 载荷
 */
suspend fun sendNodeSignal(toNodeHash: String, bytes: ByteArray) {
	var anyCapable = false
	var lastError: Exception? = null
	for (provider in listDiscoveryProviders()) {
		try {
			val result = provider.sendNodeSignal(toNodeHash, bytes) ?: continue
			anyCapable = true
			if (result) return
		}
		catch (error: Exception) {
			lastError = error
		}
	}
	if (lastError != null) throw lastError
	if (!anyCapable) throw IllegalStateException("p2p: signaling unavailable")
	throw IllegalStateException("p2p: signaling unavailable")
}

/**
 * 在各可信令介质上监听；返回统一取消。
 * @param localNodeHash 本机 nodeHash
 * @param onSignal 回调
 * @return 取消函数
 */
suspend fun listenNodeSignals(localNodeHash: String, onSignal: (ByteArray) -> Unit): () -> Unit {
	val cleanups = ArrayList<() -> Unit>()
	var anyCapable = false
	for (provider in listDiscoveryProviders()) {
		try {
			val cleanup = provider.listenNodeSignals(localNodeHash, onSignal) ?: continue
			anyCapable = true
			cleanups.add(cleanup)
		}
		catch (_: Exception) {
			// ignore provider
		}
	}
	if (!anyCapable) throw IllegalStateException("p2p: signaling unavailable")
	return composeCleanups(cleanups)
}

private fun composeCleanups(cleanups: List<() -> Unit>): () -> Unit = {
	for (cleanup in cleanups) try {
		cleanup()
	}
	catch (_: Exception) {
		// ignore
	}
}

/**
 * 启动各 provider 的 presence（若支持）。
 * @param getBeacon 本机 beacon
 * @return 统一停止函数
 */
suspend fun startDiscoveryPresence(getBeacon: suspend () -> Map<String, Any?>?): () -> Unit {
	val cleanups = ArrayList<() -> Unit>()
	for (provider in listDiscoveryProviders()) {
		try {
			provider.startPresence(getBeacon)?.let { cleanups.add(it) }
		}
		catch (_: Exception) {
			// ignore
		}
	}
	return composeCleanups(cleanups)
}

/**
 * 监听指定 nodeHash 的 advert（各支持介质 fan-in）。
 * @param nodeHash 目标 nodeHash
 * @param onAdvert 回调
 * @return 取消函数
 */
suspend fun watchNodeAdvert(nodeHash: String, onAdvert: (ByteArray, Map<String, Any?>) -> Unit): () -> Unit {
	val cleanups = ArrayList<() -> Unit>()
	var anyCapable = false
	for (provider in listDiscoveryProviders()) {
		try {
			val cleanup = provider.watchNodeAdvert(nodeHash, onAdvert) ?: continue
			anyCapable = true
			cleanups.add(cleanup)
		}
		catch (_: Exception) {
			// ignore
		}
	}
	if (!anyCapable) throw IllegalStateException("p2p: node advert watch unavailable")
	return composeCleanups(cleanups)
}

/**
 * 群 advert 监听（各支持介质 fan-in）。
 * @param roomSecret 房间密钥
 * @param onAdvert 回调
 * @return 取消群 advert 监听
 */
suspend fun watchGroupAdverts(roomSecret: String, onAdvert: (ByteArray, Map<String, Any?>) -> Unit): () -> Unit {
	val cleanups = ArrayList<() -> Unit>()
	var anyCapable = false
	for (provider in listDiscoveryProviders()) {
		try {
			val cleanup = provider.watchGroupAdverts(roomSecret, onAdvert) ?: continue
			anyCapable = true
			cleanups.add(cleanup)
		}
		catch (_: Exception) {
			// ignore
		}
	}
	if (!anyCapable) throw IllegalStateException("p2p: group advert watch unavailable")
	return composeCleanups(cleanups)
}

/**
 * 群 presence 广播（各支持介质 fan-out）。
 * @param roomSecret 房间密钥
 * @param getBeacon advert 工厂
 * @return 停止群 presence 广播
 */
suspend fun startGroupPresence(roomSecret: String, getBeacon: suspend () -> Map<String, Any?>?): () -> Unit {
	val cleanups = ArrayList<() -> Unit>()
	var anyCapable = false
	for (provider in listDiscoveryProviders()) {
		try {
			val cleanup = provider.startGroupPresence(roomSecret, getBeacon) ?: continue
			anyCapable = true
			cleanups.add(cleanup)
		}
		catch (_: Exception) {
			// ignore
		}
	}
	if (!anyCapable) throw IllegalStateException("p2p: group presence unavailable")
	return composeCleanups(cleanups)
}

/**
 * 向节点发送 JSON 信令包（discovery 内部加解密）。
 * @param toNodeHash 目标 nodeHash
 * @param packet JSON 载荷
 */
suspend fun sendNodeSignalPacket(toNodeHash: String, packet: Any?) {
	sendNodeSignal(toNodeHash, encryptSignalPacket(nodeRendezvousKey(toNodeHash), packet))
}

/**
 * 解密发往本机的节点信令包。
 * @param localNodeHash 本机 nodeHash
 * @param bytes 加密字节
 * @return 解密 JSON
 */
fun decryptNodeSignalPacket(localNodeHash: String, bytes: ByteArray): Map<String, Any?>? =
	decryptSignalPacket(nodeRendezvousKey(localNodeHash), bytes)

/**
 * advert 验签后写入各介质可见池。
 * @param verifiedNodeHash 已验签 nodeHash
 * @param options 带 roomSecret 时写入群池
 */
fun noteVisibleNodeFromAdvert(verifiedNodeHash: String, options: Map<String, Any?> = emptyMap()) {
	for (provider in listDiscoveryProviders()) provider.noteVisibleNode(verifiedNodeHash, options)
}

/**
 * 监听指定 nodeHash 的 advert，验签后回调。
 * @param nodeHash 目标 nodeHash
 * @param onAdvert 回调
 * @return 取消函数
 */
suspend fun watchVerifiedNodeAdvert(
	nodeHash: String,
	onAdvert: suspend (String, Map<String, Any?>, Map<String, Any?>) -> Unit,
): () -> Unit = watchNodeAdvert(nodeHash) { bytes, meta ->
	discoveryScope.launch {
		val ingested = ingestNodeAdvert(nodeHash, bytes) ?: return@launch
		noteVisibleNodeFromAdvert(ingested["verifiedNodeHash"] as String)
		onAdvert(ingested["verifiedNodeHash"] as String, ingested["body"] as Map<String, Any?>, meta)
	}
}

/**
 * 群 advert 监听 + 验签；写入群可见池。
 * @param roomSecret 房间密钥
 * @param onAdvert 回调
 * @return 取消群 advert 验签监听
 */
suspend fun watchVerifiedGroupAdverts(
	roomSecret: String,
	onAdvert: suspend (String, Map<String, Any?>, Map<String, Any?>) -> Unit,
): () -> Unit = watchGroupAdverts(roomSecret) { bytes, meta ->
	discoveryScope.launch {
		val ingested = ingestGroupAdvert(roomSecret, bytes) ?: return@launch
		noteVisibleNodeFromAdvert(ingested["verifiedNodeHash"] as String, mapOf("roomSecret" to roomSecret))
		onAdvert(ingested["verifiedNodeHash"] as String, ingested["body"] as Map<String, Any?>, meta)
	}
}
