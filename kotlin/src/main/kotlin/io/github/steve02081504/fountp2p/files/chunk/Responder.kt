package io.github.steve02081504.fountp2p.files.chunk

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.federation.jsTruthy
import io.github.steve02081504.fountp2p.files.manifest.handleIncomingManifestGet
import io.github.steve02081504.fountp2p.files.manifest.resolvePendingManifestFetch
import io.github.steve02081504.fountp2p.registries.ActionRoom
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Trystero room：注册带 requestId 的 fed_chunk_* + fed_manifest_*（等价 `files/chunk/responder.mjs`）。
 */

/** 出站限速队列。 */
fun interface FedOutQueue {
	/**
	 * @param priority 优先级
	 * @param cleanup 发送动作
	 */
	fun enqueue(priority: Int, cleanup: () -> Unit)
}

/** RTC 负载守卫。 */
typealias FedGuardGet = (roomKey: String, action: String, rtcLimits: Map<String, Any?>) -> Boolean

private val fedRoomScope = CoroutineScope(Dispatchers.Default + SupervisorJob())

/**
 * @param sendData 发送
 * @param fedOut 出站限速队列
 * @return 可入队的发送
 */
private fun wrapSend(
	sendData: (resp: Any?, peerId: String) -> Unit,
	fedOut: FedOutQueue?,
): (resp: Any?, peerId: String) -> Unit {
	if (fedOut == null) return sendData
	return { resp, peerId ->
		fedOut.enqueue(6) {
			try {
				sendData(resp, peerId)
			}
			catch (_: Throwable) {
				// peer gone
			}
		}
	}
}

/**
 * @param room Trystero room
 * @param fedOut 出站队列
 * @param guardGet RTC 负载守卫
 * @param rtcLimits RTC 限额
 * @param roomKey 房间键
 */
fun attachTrustGraphFedChunkResponder(
	room: ActionRoom,
	fedOut: FedOutQueue? = null,
	guardGet: FedGuardGet? = null,
	rtcLimits: Map<String, Any?> = emptyMap(),
	roomKey: String = "",
) {
	val (sendChunkData, getChunkData) = room.makeAction("fed_chunk_data")
	val (_, getChunkGet) = room.makeAction("fed_chunk_get")
	val (sendManifestData, getManifestData) = room.makeAction("fed_manifest_data")
	val (_, getManifestGet) = room.makeAction("fed_manifest_get")

	val sendChunk = wrapSend({ resp, peerId ->
		try {
			sendChunkData.send(resp, peerId)
		}
		catch (_: Throwable) {
			// peer gone
		}
	}, fedOut)
	val sendManifest = wrapSend({ resp, peerId ->
		try {
			sendManifestData.send(resp, peerId)
		}
		catch (_: Throwable) {
			// peer gone
		}
	}, fedOut)

	getChunkGet.register { data, peerId ->
		if (guardGet != null && !guardGet(roomKey, "fed_chunk_get", rtcLimits)) return@register
		if (!jsTruthy(Json.at(data, "requestId"))) return@register
		fedRoomScope.launch { handleIncomingChunkGet(data, sendChunk, peerId ?: "") }
	}

	getChunkData.register { data, _ ->
		if (!jsTruthy(Json.at(data, "requestId"))) return@register
		resolvePendingChunkFetch(data)
	}

	getManifestGet.register { data, peerId ->
		if (guardGet != null && !guardGet(roomKey, "fed_manifest_get", rtcLimits)) return@register
		if (!jsTruthy(Json.at(data, "requestId"))) return@register
		fedRoomScope.launch { handleIncomingManifestGet(data, sendManifest, peerId ?: "") }
	}

	getManifestData.register { data, peerId ->
		if (!jsTruthy(Json.at(data, "requestId"))) return@register
		val out = LinkedHashMap<String, Any?>()
		if (data is Map<*, *>) for ((key, value) in data) if (key is String) out[key] = value
		out["senderNodeHash"] = peerId ?: ""
		fedRoomScope.launch { resolvePendingManifestFetch(out) }
	}
}
