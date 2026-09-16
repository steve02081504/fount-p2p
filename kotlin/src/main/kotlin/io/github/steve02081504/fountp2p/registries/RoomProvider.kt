package io.github.steve02081504.fountp2p.registries

/**
 * 联邦房间 Provider 注册表（`registries/room_provider.mjs` 的等价实现）：
 * P2P 层通过 Provider 获取群房间，不 import Chat Shell。
 */

/** 房间 roster 成员。 */
data class RosterPeer(val peerId: String, val remoteNodeHash: String? = null)

/** 联邦房间槽位。 */
data class FederationRoomSlot(
	val groupId: String,
	val getRoster: () -> List<RosterPeer>,
	val getPeerIdByNodeHash: (String) -> String?,
	val sendToPeer: (peerId: String, actionName: String, payload: Any?) -> Unit,
	val pickFallbackPeerIds: (suspend (String) -> List<String>)? = null,
)

/** 枚举活跃房间的 Provider。 */
typealias FederationRoomEnumerator = suspend (String) -> List<FederationRoomSlot>

/** ownerId → 枚举函数。 */
private val providers = LinkedHashMap<String, FederationRoomEnumerator>()

/**
 * @param ownerId 注册方（如 chat）
 * @param enumerateRooms 枚举活跃房间
 */
fun registerFederationRoomProvider(ownerId: String, enumerateRooms: FederationRoomEnumerator) {
	providers[ownerId] = enumerateRooms
}

/**
 * @param ownerId 注册方
 */
fun unregisterFederationRoomProvider(ownerId: String) {
	providers.remove(ownerId)
}

/**
 * @param username 副本用户名 登录名
 * @return 所有 Provider 提供的活跃 sync 房间
 */
suspend fun listFederationRoomSlots(username: String): List<FederationRoomSlot> {
	val slots = ArrayList<FederationRoomSlot>()
	for (enumerate in providers.values) {
		val batch = enumerate(username)
		if (batch.isNotEmpty()) slots.addAll(batch)
	}
	return slots
}
