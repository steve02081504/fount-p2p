package io.github.steve02081504.fountp2p.transport

import io.github.steve02081504.fountp2p.node.bumpLocalDataRevision
import io.github.steve02081504.fountp2p.registries.FederationRoomSlot
import io.github.steve02081504.fountp2p.registries.RosterPeer
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * 加入远端用户房间（等价 `js/transport/remote_user_room.mjs`）。
 *
 * 偏离：JS 在 import 时注册 FederationRoomProvider；Kotlin 惰性注册（见 [ensureUserRoomProviders]）。
 */

/** 远端用户房间槽。 */
class RemoteUserRoomSlot(
	val roomSlot: FederationRoomSlot,
	val leave: suspend () -> Unit,
)

private val remoteUserRoomScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

/** nodeHash → slot。 */
private val remoteSlots = LinkedHashMap<String, RemoteUserRoomSlot>()

/** nodeHash → 进行中的 promise。 */
private val remoteInflights = LinkedHashMap<String, CompletableDeferred<RemoteUserRoomSlot>>()

/** @return 所有远端用户房间的 FederationRoomSlot 列表 */
fun remoteUserRoomSlots(): List<FederationRoomSlot> = remoteSlots.values.map { it.roomSlot }

/** 测试用：清空远端房间槽。 */
fun resetRemoteUserRoomsForTests() {
	remoteSlots.clear()
	remoteInflights.clear()
}

/**
 * 加入目标节点的用户房间（幂等）。
 * @param targetNodeHash 目标节点 64 hex
 * @return 房间槽
 */
suspend fun ensureRemoteUserRoom(targetNodeHash: String): RemoteUserRoomSlot {
	remoteSlots[targetNodeHash]?.let { return it }
	remoteInflights[targetNodeHash]?.let { return it.await() }

	val deferred = CompletableDeferred<RemoteUserRoomSlot>()
	remoteInflights[targetNodeHash] = deferred
	try {
		val link = ensureLinkToNode(targetNodeHash)
		if (link == null)
			throw IllegalStateException("p2p: ensureRemoteUserRoom link failed for $targetNodeHash")

		val roomSlot = FederationRoomSlot(
			groupId = USER_ROOM_SCOPE,
			getRoster = {
				if (getLink(targetNodeHash) != null)
					listOf(RosterPeer(peerId = targetNodeHash, remoteNodeHash = targetNodeHash))
				else emptyList()
			},
			getPeerIdByNodeHash = { nh -> if (getLink(nh) != null) nh else null },
			// 始终走当前规范链路；glare 择一后最初返回的链路可能已被关闭。
			sendToPeer = { _, actionName, payload ->
				remoteUserRoomScope.launch {
					try {
						getLink(targetNodeHash)?.send(
							linkedMapOf("scope" to "node", "action" to actionName, "payload" to payload),
						)
					}
					catch (_: Exception) {
						// ignore
					}
				}
			},
		)

		val slot = RemoteUserRoomSlot(
			roomSlot = roomSlot,
			leave = {
				remoteSlots.remove(targetNodeHash)
				closeLink(targetNodeHash, "remote-user-room-release")
			},
		)
		remoteSlots[targetNodeHash] = slot
		bumpLocalDataRevision()
		deferred.complete(slot)
		return slot
	}
	finally {
		remoteInflights.remove(targetNodeHash)
	}
}
