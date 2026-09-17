package io.github.steve02081504.fountp2p.transport

import io.github.steve02081504.fountp2p.discovery.noteAdvertPeerHints
import io.github.steve02081504.fountp2p.discovery.startGroupPresence
import io.github.steve02081504.fountp2p.discovery.watchVerifiedGroupAdverts
import io.github.steve02081504.fountp2p.node.loadPeerPoolView
import io.github.steve02081504.fountp2p.node.loadReputation
import io.github.steve02081504.fountp2p.registries.RosterPeer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * 基于 link registry 的群组联邦房间（等价 `js/transport/group_link_set.mjs`，唯一内核；
 * `scoped_link.mjs` 为其薄预设）。
 *
 * 偏离：JS `registry` 为无类型对象，Kotlin 以 [GroupRegistry] 注入；定时器改为 coroutine。
 */

/** 群组 link set 依赖的 registry。 */
interface GroupRegistry {
	/** 本地身份（读取 `nodeHash`）。 */
	val localIdentity: Map<String, Any?>

	/** 确保 discovery/link runtime 启动。 */
	suspend fun ensureRuntime() {}

	/**
	 * @param scope scope 名称
	 * @param nodeHashes 成员 nodeHash 列表
	 */
	fun registerScopeInterest(scope: String, nodeHashes: List<String>) {}

	/**
	 * @param scope scope 名称
	 */
	fun releaseScopeInterest(scope: String) {}

	/**
	 * @param prefix scope 前缀
	 * @param listener 入站 envelope 回调（发送方 nodeHash + `{ scope, action, payload }`）
	 * @return 取消订阅
	 */
	fun subscribeScope(prefix: String, listener: (senderNodeHash: String, envelope: Map<String, Any?>) -> Unit): () -> Unit

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

	/**
	 * @param nodeHash 节点 64 hex
	 * @return 链路或 null
	 */
	fun getLink(nodeHash: String): Any?

	/**
	 * @param nodeHash 目标 nodeHash
	 * @return 链路或 null
	 */
	suspend fun ensureLinkToNode(nodeHash: String): Any?

	/**
	 * @param remoteNodeHash 远端节点 64 hex
	 * @param envelope 信封
	 * @return 是否发送成功
	 */
	suspend fun sendToNodeLink(remoteNodeHash: String, envelope: Map<String, Any?>): Boolean

	/**
	 * @param options `{ roomSecret }` 时构建群 advert
	 * @return 签名 advert body
	 */
	suspend fun buildLocalAdvert(options: Map<String, Any?>): Map<String, Any?>
}

/** 群 action 的发送/注册元组。 */
class GroupAction(
	val send: suspend (payload: Any?, peerId: Any?) -> Unit,
	val on: ((payload: Any?, peerId: String) -> Unit) -> Unit,
)

private class ActionEntry {
	var handler: ((payload: Any?, peerId: String) -> Unit)? = null
	val backlog = ArrayList<Pair<Any?, String>>()
}

/**
 * 创建群组 link set。
 * @param options 选项
 * @return 群组 link set 接口
 */
@JvmOverloads
fun createGroupLinkSet(
	groupId: String,
	options: GroupLinkSetOptions = GroupLinkSetOptions(),
): GroupLinkSet {
	val registry = options.registry ?: getLinkRegistry()
	return GroupLinkSet(groupId, options, registry)
}

/**
 * [createGroupLinkSet] 选项。
 */
class GroupLinkSetOptions(
	val scope: String? = null,
	val roomSecret: String? = null,
	val members: List<String> = emptyList(),
	val allowNode: ((nodeHash: String) -> Boolean)? = null,
	val dialAll: Boolean = false,
	val autoconnect: Boolean = true,
	val groupSettings: Map<String, Any?>? = null,
	val registry: GroupRegistry? = null,
)

/** 群组 link set（等价 JS `createGroupLinkSet` 返回对象）。 */
class GroupLinkSet internal constructor(
	/** 群 ID */
	val groupId: String,
	options: GroupLinkSetOptions,
	private val registry: GroupRegistry,
) {
	/** scope 前缀 */
	val scope: String = options.scope ?: "group:$groupId"

	private val roomSecret = options.roomSecret
	private val dialAll = options.dialAll
	private val allowNode = options.allowNode ?: { true }
	private val startWithAutoconnect = options.autoconnect
	private val members = LinkedHashSet(options.members)
	private val selfNodeHash = registry.localIdentity["nodeHash"]?.toString() ?: ""
	private val groupSettings = options.groupSettings ?: emptyMap()
	private val initialAnchors = LinkedHashSet(options.members)

	private val scope2 = CoroutineScope(SupervisorJob() + Dispatchers.Default)
	private var dialTimer: Job? = null
	private var scanTimer: Job? = null

	private val cleanups = LinkedHashSet<() -> Unit>()
	private val envelopeListeners = LinkedHashSet<(String, Map<String, Any?>) -> Unit>()
	private val peerJoinListeners = LinkedHashSet<(String) -> Unit>()
	private val peerLeaveListeners = LinkedHashSet<(String) -> Unit>()
	private val announcedPeers = LinkedHashSet<String>()
	private val actionEntries = LinkedHashMap<String, ActionEntry>()

	private var autoconnectEnabled = false
	private var active = true
	private var started = false

	private fun registerCleanup(cleanup: (() -> Unit)?) {
		if (cleanup == null) return
		cleanups.add(cleanup)
	}

	private fun notePeerJoin(peerId: String?) {
		if (peerId.isNullOrEmpty() || !allowNode(peerId) || announcedPeers.contains(peerId)) return
		announcedPeers.add(peerId)
		for (listener in peerJoinListeners.toList()) try {
			listener(peerId)
		}
		catch (_: Throwable) {
			// ignore
		}
	}

	private fun notePeerLeave(peerId: String?) {
		if (peerId.isNullOrEmpty() || !announcedPeers.contains(peerId)) return
		announcedPeers.remove(peerId)
		for (listener in peerLeaveListeners.toList()) try {
			listener(peerId)
		}
		catch (_: Throwable) {
			// ignore
		}
	}

	private fun notePeerCandidate(nodeHash: String?) {
		if (nodeHash.isNullOrEmpty() || nodeHash == selfNodeHash || !allowNode(nodeHash)) return
		if (members.contains(nodeHash)) {
			if (registry.getLink(nodeHash) != null) notePeerJoin(nodeHash)
			return
		}
		members.add(nodeHash)
		registry.registerScopeInterest(scope, members.toList())
		if (registry.getLink(nodeHash) != null) notePeerJoin(nodeHash)
		scheduleDial()
	}

	/** 按成员选择目标并拨号。 */
	private fun selectAndDial() {
		if (!autoconnectEnabled || !active) return
		val targets = if (dialAll) {
			members.filter { it != selfNodeHash && allowNode(it) }
		}
		else {
			selectLinkTargetsFromMembers(
				members = members,
				selfNodeHash = selfNodeHash,
				rep = loadReputation(),
				peers = loadPeerPoolView(groupId),
				limits = resolveFederationPoolLimits(groupSettings),
				anchors = initialAnchors,
			).filter { allowNode(it) }
		}
		for (nodeHash in targets)
			if (nodeHash != selfNodeHash && registry.getLink(nodeHash) == null)
				scope2.launch {
					try {
						registry.ensureLinkToNode(nodeHash)
					}
					catch (_: Exception) {
						// ignore
					}
				}
	}

	/** 延迟调度一次拨号。 */
	private fun scheduleDial() {
		if (!autoconnectEnabled || !active || dialTimer != null) return
		dialTimer = scope2.launch {
			delay(200)
			dialTimer = null
			selectAndDial()
		}
	}

	private suspend fun scanVisibleMembers() {
		val tunables = loadTransportTunables()
		val raw = (tunables["groupMemberScanLimit"] as? Number)?.toDouble()
			?: (tunables["meshScanLimit"] as? Number)?.toDouble() ?: 64.0
		val limit = maxOf(8.0, raw).toInt()
		val options = linkedMapOf<String, Any?>("limit" to limit.toDouble())
		if (!roomSecret.isNullOrEmpty()) options["roomSecret"] = roomSecret
		for (hash in io.github.steve02081504.fountp2p.discovery.listVisibleNodeHashes(options))
			notePeerCandidate(hash)
	}

	private fun getActionEntry(name: String): ActionEntry =
		actionEntries.getOrPut(name) { ActionEntry() }

	/** @return 当前在线 roster */
	fun getRoster(): List<RosterPeer> =
		members
			.filter { it != selfNodeHash && allowNode(it) && registry.getLink(it) != null }
			.map { RosterPeer(peerId = it, remoteNodeHash = it) }

	/** 开启成员自动拨号与 roster 维护。 */
	fun startAutoconnect() {
		autoconnectEnabled = true
		selectAndDial()
	}

	/** 停止自动拨号并清除待执行的拨号定时器。 */
	fun stopAutoconnect() {
		autoconnectEnabled = false
		dialTimer?.cancel()
		dialTimer = null
	}

	/** 开启（或重入）群房间。 */
	suspend fun start() {
		if (started) {
			if (startWithAutoconnect) startAutoconnect()
			return
		}
		started = true
		active = true
		registry.ensureRuntime()
		registry.registerScopeInterest(scope, members.toList())
		registerCleanup(
			registry.subscribeScope(scope) { senderNodeHash, envelope ->
				if (!allowNode(senderNodeHash)) return@subscribeScope
				notePeerCandidate(senderNodeHash)
				val actionName = envelope["action"]?.toString() ?: ""
				val entry = actionEntries[actionName]
				if (entry != null) {
					val handler = entry.handler
					if (handler != null) handler(envelope["payload"], senderNodeHash)
					else entry.backlog.add(envelope["payload"] to senderNodeHash)
				}
				for (listener in envelopeListeners.toList()) listener(senderNodeHash, envelope)
			},
		)
		registerCleanup(
			registry.onLinkUp { nodeHash ->
				if (!members.contains(nodeHash) || nodeHash == selfNodeHash || !allowNode(nodeHash)) return@onLinkUp
				notePeerJoin(nodeHash)
			},
		)
		registerCleanup(
			registry.onLinkDown { nodeHash, _ ->
				if (!members.contains(nodeHash) || nodeHash == selfNodeHash) return@onLinkDown
				notePeerLeave(nodeHash)
			},
		)

		registerCleanup(
			watchVerifiedGroupAdverts(roomSecret ?: "") { verifiedNodeHash, body, meta ->
				if (verifiedNodeHash == selfNodeHash) return@watchVerifiedGroupAdverts
				if (!allowNode(verifiedNodeHash)) return@watchVerifiedGroupAdverts
				noteAdvertPeerHints(verifiedNodeHash, body, meta)
				notePeerCandidate(verifiedNodeHash)
			},
		)

		registerCleanup(
			startGroupPresence(roomSecret ?: "") {
				linkedMapOf(
					"nodeHash" to selfNodeHash,
					"advertBody" to registry.buildLocalAdvert(linkedMapOf("roomSecret" to roomSecret)),
				)
			},
		)

		scanVisibleMembers()
		val scanMs = maxOf(
			5_000.0,
			(loadTransportTunables()["groupMemberScanIntervalMs"] as? Number)?.toDouble() ?: 30_000.0,
		)
		scanTimer = scope2.launch {
			while (true) {
				delay(scanMs.toLong())
				try {
					scanVisibleMembers()
				}
				catch (_: Exception) {
					// ignore
				}
			}
		}
		registerCleanup {
			scanTimer?.cancel()
			scanTimer = null
		}

		if (startWithAutoconnect) startAutoconnect()
		for (peer in getRoster()) notePeerJoin(peer.peerId)
	}

	/** 离开群房间（释放订阅与自动拨号）。 */
	suspend fun leave() {
		if (!active && !started) return
		active = false
		started = false
		stopAutoconnect()
		registry.releaseScopeInterest(scope)
		for (cleanup in cleanups.toList()) try {
			cleanup()
		}
		catch (_: Exception) {
			// ignore
		}
		cleanups.clear()
	}

	/**
	 * @param nodeHash 远端节点 hash
	 * @return 已建链时返回 peerId，否则 null
	 */
	fun getPeerIdByNodeHash(nodeHash: String): String? =
		if (registry.getLink(nodeHash) != null) nodeHash else null

	/**
	 * @param peerId 目标 peer
	 * @param actionName scope action 名
	 * @param payload 载荷
	 * @return 发送是否成功
	 */
	suspend fun sendToPeer(peerId: String, actionName: String, payload: Any?): Boolean {
		if (!allowNode(peerId)) return false
		return registry.sendToNodeLink(peerId, linkedMapOf("scope" to scope, "action" to actionName, "payload" to payload))
	}

	/**
	 * @param actionName action 名
	 * @param handler 回调
	 * @return 取消订阅
	 */
	fun onAction(actionName: String, handler: (payload: Any?, peerId: String) -> Unit): () -> Unit {
		val entry = getActionEntry(actionName)
		entry.handler = handler
		val pending = ArrayList(entry.backlog)
		entry.backlog.clear()
		for ((payload, peerId) in pending) handler(payload, peerId)
		return {
			if (entry.handler === handler) entry.handler = null
			Unit
		}
	}

	/**
	 * @param actionName action 名
	 * @param payload 载荷
	 * @param peerId 单播目标；null 则广播 roster
	 * @return 成功发送数
	 */
	@JvmOverloads
	suspend fun send(actionName: String, payload: Any?, peerId: String? = null): Int {
		if (peerId != null) return if (sendToPeer(peerId, actionName, payload)) 1 else 0
		var sent = 0
		for (peer in getRoster())
			if (registry.sendToNodeLink(peer.peerId, linkedMapOf("scope" to scope, "action" to actionName, "payload" to payload))) sent++
		return sent
	}

	/**
	 * @param listener scope envelope 回调
	 * @return 取消订阅
	 */
	fun onEnvelope(listener: (senderNodeHash: String, envelope: Map<String, Any?>) -> Unit): () -> Unit {
		envelopeListeners.add(listener)
		return { envelopeListeners.remove(listener); Unit }
	}

	/**
	 * @param listener peer 加入回调
	 * @return 取消订阅
	 */
	fun onPeerJoin(listener: (peerId: String) -> Unit): () -> Unit {
		peerJoinListeners.add(listener)
		for (peer in getRoster()) if (peer.peerId.isNotEmpty()) announcedPeers.add(peer.peerId)
		for (peerId in announcedPeers.toList()) try {
			listener(peerId)
		}
		catch (_: Exception) {
			// ignore
		}
		return { peerJoinListeners.remove(listener); Unit }
	}

	/**
	 * @param listener peer 离开回调
	 * @return 取消订阅
	 */
	fun onPeerLeave(listener: (peerId: String) -> Unit): () -> Unit {
		peerLeaveListeners.add(listener)
		return { peerLeaveListeners.remove(listener); Unit }
	}

	/** @return 当前在线 peer 表 */
	fun getPeers(): Map<String, Boolean> = getRoster().associate { it.peerId to true }

	/**
	 * @param name action 名
	 * @return [send, onHandler] 元组
	 */
	fun makeAction(name: String): GroupAction {
		val send: suspend (Any?, Any?) -> Unit = { payload, peerId ->
			if (peerId is List<*>) {
				for (target in peerId) {
					val id = target as? String ?: continue
					sendToPeer(id, name, payload)
				}
			}
			else {
				send(name, payload, peerId as? String)
			}
		}
		val on: ((Any?, String) -> Unit) -> Unit = { handler ->
			val entry = getActionEntry(name)
			entry.handler = handler
			val pending = ArrayList(entry.backlog)
			entry.backlog.clear()
			for ((payload, peerId) in pending) handler(payload, peerId)
		}
		return GroupAction(send, on)
	}

	/** @return 群 link set 是否仍活跃 */
	fun isActive(): Boolean = active
}
