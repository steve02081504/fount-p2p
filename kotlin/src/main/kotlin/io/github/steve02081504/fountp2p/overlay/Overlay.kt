package io.github.steve02081504.fountp2p.overlay

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.hexToBytes
import io.github.steve02081504.fountp2p.crypto.pubKeyHash
import io.github.steve02081504.fountp2p.crypto.sign
import io.github.steve02081504.fountp2p.crypto.verify
import io.github.steve02081504.fountp2p.link.randomFrameIdHex
import io.github.steve02081504.fountp2p.utils.LruMap
import io.github.steve02081504.fountp2p.utils.TokenBucket
import io.github.steve02081504.fountp2p.utils.consumeToken
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * overlay 多跳路由与 relay（等价 `js/overlay/index.mjs` + `overlay/tunables.json`）。
 *
 * 偏离：JS 的 `createOverlayRouter(registry, ttl)` 中 `registry.sendToNodeLink` 为 async、
 * `subscribeScope` 为同步注册；Kotlin 以 [OverlayRegistry] 注入口，`sendToNodeLink` 为 suspend。
 * 入站 envelope 经私有 coroutine scope 派发（等价 JS 未 await 的 async handler）。
 */

private const val ROUTE_DOMAIN = "fount-route"
private const val RELAY_DOMAIN = "fount-relay"

/** 默认 overlay 限速桶；不依赖 infra 启动。 */
private val defaultOverlayRateBuckets = LinkedHashMap<String, TokenBucket>()
private val DEFAULT_OVERLAY_RATE_LIMITS = Pair(120L, 30L)

/**
 * @param senderNodeHash 发送方节点
 * @param action overlay 动作
 * @return 是否允许
 */
private fun defaultOverlayRateGate(senderNodeHash: String, action: String): Boolean {
	if (action != "route_req" && action != "relay") return true
	return consumeToken(
		defaultOverlayRateBuckets,
		senderNodeHash,
		System.currentTimeMillis(),
		DEFAULT_OVERLAY_RATE_LIMITS.first,
		DEFAULT_OVERLAY_RATE_LIMITS.second,
	)
}

private var overlayRateGate: ((String, String) -> Boolean) = ::defaultOverlayRateGate

/**
 * 安装 overlay 入站限速门（返回 false 则丢弃）。传 null 恢复默认限速。
 * @param rateGate 返回 false 则丢弃
 */
fun setOverlayRateGate(rateGate: ((String, String) -> Boolean)?) {
	overlayRateGate = rateGate ?: ::defaultOverlayRateGate
}

/** 清除自定义 overlay 限速门，恢复默认限速。 */
fun clearOverlayRateGate() {
	overlayRateGate = ::defaultOverlayRateGate
}

/**
 * @param reqId 路由请求 id
 * @param path 已遍历节点路径
 * @return 待签名字节
 */
private fun routeSignBytes(reqId: String, path: List<String>): ByteArray =
	"$ROUTE_DOMAIN\u0000$reqId\u0000${path.joinToString(",")}".toByteArray(Charsets.UTF_8)

/**
 * @param path 完整节点路径
 * @param body relay 载荷
 * @return 待签名字节
 */
private fun relaySignBytes(path: List<String>, body: Any?): ByteArray =
	"$RELAY_DOMAIN\u0000${path.joinToString(",")}\u0000${Json.stringifyCanonical(body)}".toByteArray(Charsets.UTF_8)

/** overlay router 依赖的 registry。 */
interface OverlayRegistry {
	/** 本地身份（`nodeHash` / `nodePubKey` / `secretKey`）。 */
	val localIdentity: Map<String, Any?>

	/** @return 当前活跃链路邻居 */
	fun listLinks(): List<OverlayLinkRef>

	/**
	 * @param nodeHash 目标节点 64 hex
	 * @param envelope overlay 信封
	 * @return 是否投递成功
	 */
	suspend fun sendToNodeLink(nodeHash: String, envelope: Map<String, Any?>): Boolean

	/**
	 * @param prefix scope 前缀
	 * @param handler 入站 envelope 处理器
	 * @return 取消订阅
	 */
	fun subscribeScope(prefix: String, handler: (senderNodeHash: String, envelope: Map<String, Any?>) -> Unit): () -> Unit
}

/** [OverlayRegistry.listLinks] 的元素。 */
data class OverlayLinkRef(val nodeHash: String, val link: Any? = null)

/** relay 到达元信息。 */
data class RelayMeta(val path: List<String>, val from: String)

/** overlay 路由器。 */
class OverlayRouter internal constructor(
	private val registry: OverlayRegistry,
	private val ttl: Int,
) {
	private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
	private val selfNodeHash = registry.localIdentity["nodeHash"]?.toString() ?: ""
	private val selfPubKey = registry.localIdentity["nodePubKey"]?.toString() ?: ""
	private val secretKey: ByteArray = (registry.localIdentity["secretKey"] as? ByteArray) ?: ByteArray(0)
	private val seenReqs = LruMap<String, Boolean>(4096)

	private class PendingRoute(
		val deferred: CompletableDeferred<List<String>>,
		val timer: Job,
		val target: String,
	)

	private val pendingRoutes = LinkedHashMap<String, PendingRoute>()
	private val relayListeners = LinkedHashSet<(Any?, RelayMeta) -> Unit>()

	private suspend fun sendOverlay(nodeHash: String, payload: Map<String, Any?>) {
		registry.sendToNodeLink(nodeHash, linkedMapOf("scope" to "overlay", "action" to payload["action"], "payload" to payload))
	}

	/** 处理入站 overlay envelope（route_req / route_resp / relay）。 */
	suspend fun handleOverlay(senderNodeHash: String, envelope: Map<String, Any?>) {
		val payload = envelope["payload"] as? Map<String, Any?> ?: return
		val action = envelope["action"]?.toString() ?: ""
		if (overlayRateGate(senderNodeHash, action).not()) return
		if (action == "route_req") {
			val reqId = payload["reqId"]?.toString() ?: ""
			val target = payload["target"]?.toString() ?: ""
			val hops = stringList(payload["path"])
			val remainingTtl = (payload["ttl"] as? Number)?.toDouble() ?: Double.NaN
			if (reqId.isEmpty() || target.isEmpty() || hops.isEmpty() || remainingTtl <= 0) return
			if (seenReqs.contains(reqId) || hops.contains(selfNodeHash) || hops.size > 6) return
			seenReqs.touch(reqId, true)
			val nextPath = hops + selfNodeHash
			if (target == selfNodeHash) {
				val sig = sign(routeSignBytes(reqId, nextPath), secretKey)
				val prevHop = hops.lastOrNull()
				if (!prevHop.isNullOrEmpty())
					sendOverlay(
						prevHop,
						linkedMapOf(
							"action" to "route_resp",
							"reqId" to reqId,
							"path" to nextPath,
							"nodePubKey" to selfPubKey,
							"sig" to io.github.steve02081504.fountp2p.core.bytesToHex(sig),
						),
					)
				return
			}
			for (link in registry.listLinks())
				if (link.nodeHash != senderNodeHash && !hops.contains(link.nodeHash))
					sendOverlay(
						link.nodeHash,
						linkedMapOf(
							"action" to "route_req",
							"reqId" to reqId,
							"target" to target,
							"ttl" to (remainingTtl - 1),
							"path" to nextPath,
						),
					)
			return
		}
		if (action == "route_resp") {
			val reqId = payload["reqId"]?.toString() ?: ""
			val path = stringList(payload["path"])
			val nodePubKey = payload["nodePubKey"]?.toString() ?: ""
			val sigHex = payload["sig"]?.toString() ?: ""
			if (reqId.isEmpty() || path.size < 2 || nodePubKey.isEmpty() || sigHex.isEmpty()) return
			if (pubKeyHash(safeHex(nodePubKey)) != path.last()) return
			val ok = verify(safeHex(sigHex), routeSignBytes(reqId, path), safeHex(nodePubKey))
			if (!ok) return
			if (path.first() == selfNodeHash) {
				val pending = pendingRoutes[reqId] ?: return
				// 终点必须就是本次发现的目标，否则任何直连邻居都能回一条以自己结尾的合法路径劫持路由。
				if (path.last() != pending.target) return
				pending.timer.cancel()
				pendingRoutes.remove(reqId)
				pending.deferred.complete(path)
				return
			}
			val index = path.indexOf(selfNodeHash)
			if (index <= 0) return
			sendOverlay(path[index - 1], payload)
			return
		}
		if (action == "relay") {
			val path = stringList(payload["path"])
			val index = (payload["idx"] as? Number)?.toInt() ?: 0
			if (path.isEmpty() || index !in path.indices || path[index] != selfNodeHash) return
			// origin 必须对 (path, body) 签名。
			val originPubKey = payload["nodePubKey"] as? String ?: return
			val sigHex = payload["sig"] as? String ?: return
			if (pubKeyHash(safeHex(originPubKey)) != path.first()) return
			val ok = verify(safeHex(sigHex), relaySignBytes(path, payload["body"]), safeHex(originPubKey))
			if (!ok) return
			if (index == path.size - 1) {
				val meta = RelayMeta(path, senderNodeHash)
				for (listener in relayListeners.toList()) listener(payload["body"], meta)
				return
			}
			sendOverlay(
				path[index + 1],
				linkedMapOf(
					"action" to "relay",
					"path" to path,
					"idx" to (index + 1),
					"body" to payload["body"],
					"nodePubKey" to originPubKey,
					"sig" to sigHex,
				),
			)
		}
	}

	private val unsubscribe: () -> Unit = registry.subscribeScope("overlay") { sender, envelope ->
		scope.launch { handleOverlay(sender, envelope) }
	}

	/**
	 * 发现到目标节点的签名路由路径。
	 * @param targetNodeHash 目标节点 64 hex
	 * @param options `ttl` / `timeoutMs`
	 * @return 从本节点到目标的 nodeHash 路径
	 */
	suspend fun discoverRoute(targetNodeHash: String, options: Map<String, Any?> = emptyMap()): List<String> {
		val reqId = randomFrameIdHex()
		val maxTtl = (options["ttl"] as? Number)?.toInt() ?: ttl
		val timeoutMs = (options["timeoutMs"] as? Number)?.toLong() ?: 10_000L
		val deferred = CompletableDeferred<List<String>>()
		val timer = scope.launch {
			delay(timeoutMs)
			if (deferred.isActive) {
				pendingRoutes.remove(reqId)
				deferred.completeExceptionally(IllegalStateException("overlay: route discovery timeout for $targetNodeHash"))
			}
		}
		pendingRoutes[reqId] = PendingRoute(deferred, timer, targetNodeHash)
		for (link in registry.listLinks())
			sendOverlay(
				link.nodeHash,
				linkedMapOf(
					"action" to "route_req",
					"reqId" to reqId,
					"target" to targetNodeHash,
					"ttl" to maxTtl,
					"path" to listOf(selfNodeHash),
				),
			)
		return deferred.await()
	}

	/**
	 * 沿已发现路径 relay 载荷到路径末端。
	 * @param path 路由路径（首节点须为本节点）
	 * @param body relay 载荷
	 */
	suspend fun relay(path: List<String>, body: Any?) {
		if (path.firstOrNull() != selfNodeHash || path.size < 2)
			throw IllegalStateException("overlay: invalid relay path")
		val signature = sign(relaySignBytes(path, body), secretKey)
		sendOverlay(
			path[1],
			linkedMapOf(
				"action" to "relay",
				"path" to path,
				"idx" to 1,
				"body" to body,
				"nodePubKey" to selfPubKey,
				"sig" to io.github.steve02081504.fountp2p.core.bytesToHex(signature),
			),
		)
	}

	/**
	 * @param listener relay 到达回调
	 * @return 取消订阅
	 */
	fun onRelay(listener: (Any?, RelayMeta) -> Unit): () -> Unit {
		relayListeners.add(listener)
		return { relayListeners.remove(listener); Unit }
	}

	/** 关闭路由器并清理 pending 与监听器。 */
	fun close() {
		unsubscribe()
		for (pending in pendingRoutes.values) pending.timer.cancel()
		pendingRoutes.clear()
		relayListeners.clear()
	}
}

/** @param value 任意值 @return 规范化字符串列表（非字符串元素跳过） */
private fun stringList(value: Any?): List<String> =
	(value as? List<*>)?.mapNotNull { it as? String } ?: emptyList()

/** @param hex 十六进制 @return 解码字节（非法时空数组，verify 会失败） */
private fun safeHex(hex: String): ByteArray = try {
	hexToBytes(hex)
}
catch (_: Exception) {
	ByteArray(0)
}

/**
 * 创建 overlay 多跳路由与 relay 路由器。
 * @param registry overlay registry
 * @param ttl 默认路由 TTL（最大跳数）
 * @return 路由器接口
 */
@JvmOverloads
fun createOverlayRouter(registry: OverlayRegistry, ttl: Int = 3): OverlayRouter = OverlayRouter(registry, ttl)
