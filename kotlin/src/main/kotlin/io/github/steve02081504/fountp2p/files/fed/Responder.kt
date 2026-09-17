package io.github.steve02081504.fountp2p.files.fed

import io.github.steve02081504.fountp2p.files.chunk.handleIncomingChunkGet
import io.github.steve02081504.fountp2p.files.chunk.resolvePendingChunkFetch
import io.github.steve02081504.fountp2p.files.manifest.handleIncomingManifestGet
import io.github.steve02081504.fountp2p.files.manifest.resolvePendingManifestFetch
import io.github.steve02081504.fountp2p.wire.WireAdapter
import io.github.steve02081504.fountp2p.wire.WireHandler
import io.github.steve02081504.fountp2p.wire.subscribeWire
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * node scope wire：注册 fed_chunk_* + fed_manifest_*（等价 `files/fed/responder.mjs`）。
 */

private val fedResponderScope = CoroutineScope(Dispatchers.Default + SupervisorJob())

/**
 * @param wire action 表
 * @return 取消挂载的 dispose
 */
fun attachNodeScopeFedResponder(wire: WireAdapter): () -> Unit {
	val handlers = LinkedHashMap<String, WireHandler>()
	handlers["fed_chunk_get"] = { data, peerId ->
		fedResponderScope.launch {
			handleIncomingChunkGet(
				data,
				{ resp, pid ->
					try {
						wire.send("fed_chunk_data", resp, pid)
					}
					catch (_: Throwable) {
						// disconnected
					}
				},
				peerId,
			)
		}
	}
	handlers["fed_chunk_data"] = { data, _ ->
		resolvePendingChunkFetch(data)
		Unit
	}
	handlers["fed_manifest_get"] = { data, peerId ->
		fedResponderScope.launch {
			handleIncomingManifestGet(
				data,
				{ resp, pid ->
					try {
						wire.send("fed_manifest_data", resp, pid)
					}
					catch (_: Throwable) {
						// disconnected
					}
				},
				peerId,
			)
		}
	}
	handlers["fed_manifest_data"] = { data, peerId ->
		fedResponderScope.launch {
			resolvePendingManifestFetch(withSenderNodeHash(data, peerId))
		}
	}
	return subscribeWire(wire, handlers)
}

/**
 * 等价 JS `{ ...data, senderNodeHash: peerId }`。
 * @param data 入站载荷
 * @param peerId 对端
 * @return 带 senderNodeHash 的载荷
 */
private fun withSenderNodeHash(data: Any?, peerId: String): Map<String, Any?> {
	val out = LinkedHashMap<String, Any?>()
	if (data is Map<*, *>) for ((key, value) in data) if (key is String) out[key] = value
	out["senderNodeHash"] = peerId
	return out
}
