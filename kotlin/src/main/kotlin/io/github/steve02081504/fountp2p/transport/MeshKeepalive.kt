package io.github.steve02081504.fountp2p.transport

import io.github.steve02081504.fountp2p.discovery.listVisibleNodeHashes
import io.github.steve02081504.fountp2p.node.applyNetworkHint
import io.github.steve02081504.fountp2p.node.getRoutingProfile
import io.github.steve02081504.fountp2p.node.loadPeerPoolView
import io.github.steve02081504.fountp2p.node.loadReputation
import io.github.steve02081504.fountp2p.node.nodeDebug
import io.github.steve02081504.fountp2p.node.promoteExplorePeer
import io.github.steve02081504.fountp2p.node.shortHash
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * mesh 保活控制器（等价 `js/transport/mesh_keepalive.mjs`）。
 *
 * 偏离：JS 用 `setInterval`；Kotlin 用 coroutine 循环。JS 的 `registry` 是无类型对象，
 * Kotlin 以 [MeshRegistry] / [MeshLink] 接口注入。
 */

/** 本机主动关链：不清槽重拨，由下次 tick / 调用方决定。 */
private val INTENTIONAL_CLOSE = setOf(
	"budget-evict",
	"manual-close",
	"registry-shutdown",
	"inbound-no-nodehash",
)

/**
 * @param reason 关链原因
 * @return 是否为本机主动关链（不重拨）
 */
fun isMeshIntentionalClose(reason: String?): Boolean = INTENTIONAL_CLOSE.contains(reason ?: "")

/** mesh 控制器依赖的链路句柄。 */
interface MeshLink {
	/** 数据 provider id（等价 JS `link.providerId`）。 */
	val providerId: String? get() = null

	/**
	 * @param reason 关链原因
	 */
	suspend fun close(reason: String)
}

/** mesh 控制器依赖的 registry。 */
interface MeshRegistry {
	/** 本地身份（读取 `nodeHash`）。 */
	val localIdentity: Map<String, Any?>

	/** @return 当前链路列表 */
	fun listLinks(): List<MeshLinkRef>

	/**
	 * @param nodeHash 目标 nodeHash
	 * @return 已有链路或 null
	 */
	fun getLink(nodeHash: String): MeshLink?

	/**
	 * @param nodeHash 目标 nodeHash
	 * @return 链路实例或 null
	 */
	suspend fun ensureLinkToNode(nodeHash: String): MeshLink?

	/**
	 * @param listener link up 回调
	 * @return 取消订阅
	 */
	fun onLinkUp(listener: (nodeHash: String) -> Unit): () -> Unit

	/**
	 * @param listener link down 回调
	 * @return 取消订阅
	 */
	fun onLinkDown(listener: (nodeHash: String, reason: String) -> Unit): () -> Unit
}

/** [MeshRegistry.listLinks] 的元素。 */
data class MeshLinkRef(val nodeHash: String, val link: MeshLink?)

/** mesh 保活控制器。 */
class MeshKeepalive internal constructor(
	private val registry: MeshRegistry,
	private val enabled: Boolean,
) {
	private val tunables = loadTransportTunables()
	private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

	private var loopJob: Job? = null
	private var tickInflight: Job? = null

	/** 探索链路集合（trim 时优先驱逐）。 */
	val exploreLinkHashes: MutableSet<String> = LinkedHashSet()

	private val exploreStableSince = LinkedHashMap<String, Double>()
	private var stopLinkDown: (() -> Unit)? = null
	private var stopLinkUp: (() -> Unit)? = null

	/**
	 * 非熟人活跃链记入探索槽（含入站）；熟人则清掉探索标记。
	 * @param nodeHash 对端
	 * @param trustedPeers 熟人表；null 则读盘
	 */
	private fun syncExploreMark(nodeHash: String?, trustedPeers: List<String>? = null) {
		if (nodeHash.isNullOrEmpty()) return
		val trusted = trustedPeers ?: loadPeerPoolView().trustedPeers
		if (trusted.contains(nodeHash)) {
			exploreLinkHashes.remove(nodeHash)
			exploreStableSince.remove(nodeHash)
			return
		}
		exploreLinkHashes.add(nodeHash)
	}

	/**
	 * 为拨号腾出空位：优先踢探索。
	 * @param needSlots 需要空位
	 * @param trustedPeers 熟人表
	 */
	private suspend fun evictExploreForRoom(needSlots: Int, trustedPeers: List<String>) {
		for (i in 0 until needSlots) {
			val connected = registry.listLinks().map { it.nodeHash }
			val victimHash = pickMeshEvictionVictim(connected, exploreLinkHashes, trustedPeers) { 0.0 }
			if (victimHash.isNullOrEmpty() || trustedPeers.contains(victimHash)) break
			val entry = registry.listLinks().firstOrNull { it.nodeHash == victimHash }
			val link = entry?.link ?: break
			link.close("budget-evict")
			exploreLinkHashes.remove(victimHash)
			exploreStableSince.remove(victimHash)
			nodeDebug("p2p:mesh evict", linkedMapOf("peer" to shortHash(victimHash), "reason" to "budget-evict"))
		}
	}

	/** 单次扫描 / 拨号 / 晋升。 */
	private suspend fun tick() {
		if (!enabled) return
		val limits = resolveMeshPoolLimits(getRoutingProfile(), tunables)
		val promoteMs = maxOf(60_000.0, (tunables["meshPromoteStableMs"] as? Number)?.toDouble() ?: 30 * 60_000.0)
		val scanLimit = maxOf(8.0, (tunables["meshScanLimit"] as? Number)?.toDouble() ?: 64.0).toInt()
		val visible = listVisibleNodeHashes(linkedMapOf("limit" to scanLimit.toDouble()))
		for (hash in visible)
			applyNetworkHint(
				linkedMapOf(
					"nodeHash" to hash,
					"source" to "mesh:scan",
					"kind" to "visible",
					"weight" to 0.15,
				),
			)

		val peers = loadPeerPoolView()
		val rep = loadReputation()
		val now = System.currentTimeMillis().toDouble()
		val connected = registry.listLinks().map { it.nodeHash }.toSet()
		for (nodeHash in connected)
			syncExploreMark(nodeHash, peers.trustedPeers)

		val exploreCandidates = LinkedHashSet<String>()
		exploreCandidates.addAll(peers.explorePeers)
		exploreCandidates.addAll(visible)
		val targets = selectMeshLinkTargets(
			selfNodeHash = registry.localIdentity["nodeHash"]?.toString() ?: "",
			trustedPeers = peers.trustedPeers,
			exploreCandidates = exploreCandidates.toList(),
			hintSources = peers.hintSources,
			limits = limits,
			connectedHashes = connected,
			rep = rep,
			blockedPeers = peers.blockedPeers,
			now = now,
		)
		val toDial = targets.filter { !connected.contains(it) }
		nodeDebug(
			"p2p:mesh tick",
			linkedMapOf(
				"N" to limits.N.toDouble(),
				"K_max" to limits.K_max.toDouble(),
				"visible" to visible.map { shortHash(it) },
				"connected" to connected.map { shortHash(it) },
				"dial" to toDial.map { shortHash(it) },
			),
		)
		val overflow = connected.size + toDial.size - limits.N
		if (overflow > 0)
			evictExploreForRoom(overflow, peers.trustedPeers)

		for (nodeHash in toDial)
			scope.launch {
				try {
					val link = registry.ensureLinkToNode(nodeHash)
					if (link != null) {
						syncExploreMark(nodeHash, peers.trustedPeers)
						nodeDebug(
							"p2p:mesh dial ok",
							linkedMapOf("peer" to shortHash(nodeHash), "provider" to link.providerId),
						)
					}
					else
						nodeDebug("p2p:mesh dial miss", linkedMapOf("peer" to shortHash(nodeHash)))
				}
				catch (error: Exception) {
					nodeDebug(
						"p2p:mesh dial fail",
						linkedMapOf("peer" to shortHash(nodeHash), "err" to (error.message ?: error.toString())),
					)
				}
			}

		val connectedAfter = registry.listLinks().map { it.nodeHash }.toSet()
		for (nodeHash in connectedAfter) {
			if (peers.trustedPeers.contains(nodeHash)) {
				exploreStableSince.remove(nodeHash)
				continue
			}
			if (!exploreLinkHashes.contains(nodeHash)) continue
			val since = exploreStableSince[nodeHash] ?: now
			if (!exploreStableSince.containsKey(nodeHash)) exploreStableSince[nodeHash] = since
			else if (now - since >= promoteMs) {
				promoteExplorePeer(nodeHash)
				exploreLinkHashes.remove(nodeHash)
				exploreStableSince.remove(nodeHash)
				nodeDebug("p2p:mesh promote", linkedMapOf("peer" to shortHash(nodeHash)))
			}
		}
		for (hash in exploreStableSince.keys.toList())
			if (!connectedAfter.contains(hash)) exploreStableSince.remove(hash)
	}

	/** 触发一次 tick（去重）。 */
	private fun runTick(): Job {
		tickInflight?.let { return it }
		val job = scope.launch {
			try {
				tick()
			}
			catch (error: Exception) {
				nodeDebug("p2p:mesh tick fail", linkedMapOf("err" to (error.message ?: error.toString())))
			}
		}
		tickInflight = job
		scope.launch {
			job.join()
			if (tickInflight === job) tickInflight = null
		}
		return job
	}

	/** 启动 mesh 扫描 / 拨号 / 晋升循环。 */
	fun start() {
		if (!enabled || loopJob != null) return
		nodeDebug("p2p:mesh start", linkedMapOf("self" to shortHash(registry.localIdentity["nodeHash"]?.toString())))
		stopLinkUp = registry.onLinkUp { nodeHash -> syncExploreMark(nodeHash) }
		stopLinkDown = registry.onLinkDown { nodeHash, reason ->
			exploreLinkHashes.remove(nodeHash)
			exploreStableSince.remove(nodeHash)
			nodeDebug("p2p:mesh link down", linkedMapOf("peer" to shortHash(nodeHash), "reason" to reason))
			// 主动关链不立刻补洞；意外断链用 tick 按 N/K 重选。
			if (isMeshIntentionalClose(reason)) return@onLinkDown
			runTick()
		}
		runTick()
		val interval = maxOf(15_000.0, (tunables["meshKeepaliveIntervalMs"] as? Number)?.toDouble() ?: 60_000.0)
		loopJob = scope.launch {
			while (true) {
				delay(interval.toLong())
				runTick()
			}
		}
	}

	/** 停止保活并清空探索标记。 */
	suspend fun stop() {
		loopJob?.cancelAndJoin()
		loopJob = null
		stopLinkUp?.invoke()
		stopLinkUp = null
		stopLinkDown?.invoke()
		stopLinkDown = null
		exploreLinkHashes.clear()
		exploreStableSince.clear()
		tickInflight?.let { it.join() }
		tickInflight = null
	}
}

/**
 * 创建 mesh 保活控制器。
 * @param registry link registry
 * @param enabled 是否启用
 * @return mesh 保活控制器
 */
@JvmOverloads
fun createMeshKeepalive(registry: MeshRegistry, enabled: Boolean = true): MeshKeepalive =
	MeshKeepalive(registry, enabled)
