package io.github.steve02081504.fountp2p.transport

/**
 * 邻居链路健康聚合（等价 `js/transport/peer_health.mjs`）。
 *
 * 在 mesh/link 常态维护期间顺带统计各邻居的 RTT 与可达性：
 * 订阅 registry 的 link up/down，并对每条活跃链路监听 onRtt/onDown。
 */

/** 邻居健康记录（等价 JS `PeerHealthEntry`）。 */
data class PeerHealthEntry(
	var nodeHash: String,
	var connected: Boolean,
	var rttMs: Double?,
	var avgRttMs: Double?,
	var lastSeenAt: Double,
	var source: String?,
)

/**
 * peer health 聚合器依赖的 registry（等价 JS `registry.onLinkUp?` / `registry.onLinkDown?`）。
 *
 * 默认实现为 no-op，对应 JS 中方法缺失时的可选链跳过。
 */
interface PeerHealthRegistry {
	/**
	 * @param listener link up 回调
	 * @return 取消订阅
	 */
	fun onLinkUp(listener: (nodeHash: String, link: PeerHealthLink?) -> Unit): () -> Unit = { }

	/**
	 * @param listener link down 回调
	 * @return 取消订阅
	 */
	fun onLinkDown(listener: (nodeHash: String) -> Unit): () -> Unit = { }
}

/**
 * 活跃链路的可选接口（等价 JS `link.onRtt?` / `link.onDown?` / `link.stats?` / `link.providerId`）。
 */
interface PeerHealthLink {
	/** 数据 provider id（缺失为 null）。 */
	val providerId: String? get() = null

	/** @return 链路统计快照（缺失为 null）。 */
	fun stats(): Map<String, Any?>? = null

	/**
	 * @param callback RTT 更新回调
	 * @return 取消订阅
	 */
	fun onRtt(callback: () -> Unit): () -> Unit = { }

	/**
	 * @param callback down 回调
	 * @return 取消订阅
	 */
	fun onDown(callback: (reason: String?) -> Unit): () -> Unit = { }
}

/** @return 当前毫秒时间戳（等价 JS `Date.now()`）。 */
private fun now(): Double = System.currentTimeMillis().toDouble()

/** peer health 聚合器。 */
class PeerHealthTracker internal constructor(private val registry: PeerHealthRegistry) {
	private val entries = LinkedHashMap<String, PeerHealthEntry>()
	private val cleanups = LinkedHashMap<String, () -> Unit>()
	private val listeners = LinkedHashSet<(String, PeerHealthEntry) -> Unit>()

	private var stopUp: (() -> Unit)? = null
	private var stopDown: (() -> Unit)? = null

	init {
		start()
	}

	/**
	 * 订阅 registry 的链路事件（幂等）。
	 * `stop()` 之后可用它重新挂上监听：registry 的 link up/down 桶在 shutdown 时不会被清空，
	 * 所以重启运行时后健康记录能自然恢复。
	 */
	fun start() {
		if (stopUp != null) return
		stopUp = registry.onLinkUp { nodeHash, link ->
			if (nodeHash.isEmpty()) return@onLinkUp
			val stopRtt = link?.onRtt {
				val stats = link?.stats() ?: emptyMap()
				update(
					nodeHash,
					linkedMapOf(
						"rttMs" to stats["rttMs"],
						"avgRttMs" to stats["avgRttMs"],
						"lastSeenAt" to now(),
					),
				)
			}
			val stopLinkDown = link?.onDown {
				cleanups[nodeHash]?.invoke()
				cleanups.remove(nodeHash)
				update(nodeHash, linkedMapOf("connected" to false, "lastSeenAt" to now()))
			}
			update(
				nodeHash,
				linkedMapOf(
					"connected" to true,
					"source" to link?.providerId,
					"lastSeenAt" to now(),
				),
			)
			cleanups[nodeHash] = {
				stopRtt?.invoke()
				stopLinkDown?.invoke()
			}
		}
		stopDown = registry.onLinkDown { nodeHash ->
			if (nodeHash.isEmpty()) return@onLinkDown
			cleanups[nodeHash]?.invoke()
			cleanups.remove(nodeHash)
			update(nodeHash, linkedMapOf("connected" to false, "lastSeenAt" to now()))
		}
	}

	/**
	 * 合并补丁并通知订阅方（补丁键缺失时不改动，等价 JS `patch.x !== undefined`）。
	 * @param nodeHash 远端节点 64 hex
	 * @param patch 补丁
	 */
	private fun update(nodeHash: String, patch: Map<String, Any?>) {
		val entry = entries[nodeHash] ?: PeerHealthEntry(nodeHash, false, null, null, 0.0, null)
		if (patch.containsKey("connected")) entry.connected = patch["connected"] as? Boolean ?: false
		if (patch.containsKey("rttMs")) entry.rttMs = (patch["rttMs"] as? Number)?.toDouble()
		if (patch.containsKey("avgRttMs")) entry.avgRttMs = (patch["avgRttMs"] as? Number)?.toDouble()
		if (patch.containsKey("lastSeenAt")) entry.lastSeenAt = (patch["lastSeenAt"] as? Number)?.toDouble() ?: entry.lastSeenAt
		if (patch.containsKey("source")) entry.source = patch["source"] as? String
		entries[nodeHash] = entry
		for (listener in listeners) {
			try {
				listener(nodeHash, entry)
			}
			catch (_: Throwable) {
				// ignore
			}
		}
	}

	/**
	 * @param nodeHash 远端节点 64 hex
	 * @return 健康记录；无记录时 null
	 */
	fun getPeerHealth(nodeHash: String): PeerHealthEntry? = entries[nodeHash]

	/** @return 所有邻居健康记录 */
	fun listPeerHealth(): List<PeerHealthEntry> = entries.values.toList()

	/**
	 * @param listener 变化回调
	 * @return 取消订阅
	 */
	fun onPeerHealth(listener: (nodeHash: String, entry: PeerHealthEntry) -> Unit): () -> Unit {
		listeners.add(listener)
		return { listeners.remove(listener) }
	}

	/** 停止监听并清空聚合（start() 可重新挂上；listeners 订阅者保留）。 */
	fun stop() {
		stopUp?.invoke()
		stopDown?.invoke()
		stopUp = null
		stopDown = null
		for (cleanup in cleanups.values) cleanup()
		cleanups.clear()
		entries.clear()
	}
}

/**
 * @param registry link registry
 * @return peer health 聚合器
 */
fun createPeerHealthTracker(registry: PeerHealthRegistry): PeerHealthTracker = PeerHealthTracker(registry)
