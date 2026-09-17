package io.github.steve02081504.fountp2p.transport

import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.crypto.sha256
import io.github.steve02081504.fountp2p.node.ensureNodeDefaults
import io.github.steve02081504.fountp2p.node.getNodeHash
import io.github.steve02081504.fountp2p.registries.FederationRoomSlot
import io.github.steve02081504.fountp2p.registries.RosterPeer
import io.github.steve02081504.fountp2p.registries.registerFederationRoomProvider
import io.github.steve02081504.fountp2p.transport.node_scope.attachNodeScopeDefaultFeatures
import io.github.steve02081504.fountp2p.transport.node_scope.ensureNodeScope
import io.github.steve02081504.fountp2p.utils.shuffleInPlace
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * 用户房间（user room）槽 + 转发（等价 `js/transport/user_room.mjs`）。
 *
 * 偏离：JS 在模块 import 时注册 FederationRoomProvider；Kotlin 无法在文件加载时可靠执行，
 * 改为首次 [ensureUserRoom] / [ensureRemoteUserRoom] 时惰性注册（[ensureUserRoomProviders]）。
 */

/** User Room 随机 peer 转发默认上限。 */
const val USER_ROOM_PEER_FANOUT_DEFAULT: Int = 6

private val userRoomScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

private var userRoomInflight: CompletableDeferred<UserRoomSlot>? = null
private var userRoomSlot: UserRoomSlot? = null
private var userRoomDefaultWiresDispose: (() -> Unit)? = null
private var providersRegistered = false

/** 用户房间槽。 */
class UserRoomSlot(
	val roomId: String,
	val roomSecret: String,
	var room: Any?,
	val sendToPeer: suspend (peerId: String, actionName: String, payload: Any?) -> Boolean,
	val getRoster: () -> List<RosterPeer>,
	val getPeerIdByNodeHash: (nodeHash: String) -> String?,
)

/** @return 已创建的用户房间槽，未 ensure 时为 null */
fun getUserRoomSlot(): UserRoomSlot? = userRoomSlot

/** @return 当前所有活跃链路的 roster */
fun activeLinkRoster(): List<RosterPeer> =
	listLinks().map { RosterPeer(peerId = it.nodeHash, remoteNodeHash = it.nodeHash) }

/** 惰性注册 user-room / remote-user-room 的 FederationRoomProvider。 */
fun ensureUserRoomProviders() {
	if (providersRegistered) return
	providersRegistered = true
	registerFederationRoomProvider("user-room") {
		val slot = getUserRoomSlot() ?: return@registerFederationRoomProvider emptyList()
		listOf(
			FederationRoomSlot(
				groupId = USER_ROOM_SCOPE,
				getRoster = { slot.getRoster() },
				getPeerIdByNodeHash = { nodeHash -> slot.getPeerIdByNodeHash(nodeHash) },
				sendToPeer = { peerId, actionName, payload ->
					userRoomScope.launch {
						try {
							slot.sendToPeer(peerId, actionName, payload)
						}
						catch (_: Exception) {
							// ignore
						}
					}
				},
			),
		)
	}
	registerFederationRoomProvider("remote-user-room") { remoteUserRoomSlots() }
}

/**
 * @return user room rendezvous 凭据
 */
fun resolveUserRoomCredentials(): Map<String, Any?> {
	val nodeHash = getNodeHash()
	val password = bytesToHex(sha256("fount-user-room:$nodeHash"))
	return linkedMapOf(
		"appId" to "fount-user-fed",
		"password" to password,
		"roomId" to "fount-node-$nodeHash",
		"nodeHash" to nodeHash,
	)
}

/**
 * 用户房间槽 + runtime；默认不挂业务 wire。
 * @param replicaUsername 副本用户名
 * @param attachDefaultWires 是否挂载默认 wire
 * @return 用户房间槽
 */
@JvmOverloads
suspend fun ensureUserRoom(
	replicaUsername: String? = null,
	attachDefaultWires: Boolean = false,
): UserRoomSlot {
	ensureUserRoomProviders()
	if (replicaUsername != null) ensureNodeScope(mapOf("replicaUsername" to replicaUsername))
	userRoomSlot?.let { slot ->
		if (attachDefaultWires && userRoomDefaultWiresDispose == null)
			userRoomDefaultWiresDispose = attachNodeScopeDefaultFeatures(
				if (replicaUsername != null) mapOf("replicaUsername" to replicaUsername) else emptyMap(),
			)
		return slot
	}
	userRoomInflight?.let { return it.await() }

	val deferred = CompletableDeferred<UserRoomSlot>()
	userRoomInflight = deferred
	try {
		ensureNodeDefaults()
		getLinkRegistry().ensureRuntime()
		ensureNodeScope(if (replicaUsername != null) mapOf("replicaUsername" to replicaUsername) else emptyMap())
		if (attachDefaultWires && userRoomDefaultWiresDispose == null)
			userRoomDefaultWiresDispose = attachNodeScopeDefaultFeatures(
				if (replicaUsername != null) mapOf("replicaUsername" to replicaUsername) else emptyMap(),
			)
		val creds = resolveUserRoomCredentials()
		val slot = UserRoomSlot(
			roomId = creds["roomId"] as String,
			roomSecret = creds["password"] as String,
			room = null,
			sendToPeer = { peerId, actionName, payload ->
				try {
					sendToNodeLink(peerId, linkedMapOf("scope" to "node", "action" to actionName, "payload" to payload))
				}
				catch (_: Exception) {
					false
				}
			},
			getRoster = { activeLinkRoster() },
			getPeerIdByNodeHash = { nodeHash -> if (getLinkRegistry().getLink(nodeHash) != null) nodeHash else null },
		)
		userRoomSlot = slot
		deferred.complete(slot)
		return slot
	}
	finally {
		userRoomInflight = null
	}
}

/**
 * @param username 副本用户名
 * @param actionName 节点 scope action
 * @param payload 载荷
 * @param exceptPeerId 跳过的 peer
 * @param limit 最多转发 peer 数
 * @return 成功转发的 peer 数
 */
@JvmOverloads
suspend fun deliverToUserRoomPeers(
	username: String,
	actionName: String,
	payload: Any?,
	exceptPeerId: String? = null,
	limit: Int? = null,
): Int {
	val fanoutLimit = limit ?: USER_ROOM_PEER_FANOUT_DEFAULT
	if (fanoutLimit <= 0) return 0
	val slot = ensureUserRoom(username)
	var sent = 0
	val peers = shuffleInPlace(
		slot.getRoster().filter { it.peerId.isNotEmpty() && it.peerId != exceptPeerId }.toMutableList(),
	)
	for (peer in peers) {
		try {
			val base = LinkedHashMap<String, Any?>()
			(payload as? Map<*, *>)?.let { map -> for ((key, value) in map) if (key is String) base[key] = value }
			base["nodeHash"] = getNodeHash()
			if (slot.sendToPeer(peer.peerId, actionName, base)) sent++
			if (sent >= fanoutLimit) break
		}
		catch (_: Exception) {
			// disconnected
		}
	}
	return sent
}
