package io.github.steve02081504.fountp2p.link.providers.nostr

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.base64ToBytes
import io.github.steve02081504.fountp2p.core.bytesToBase64
import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.crypto.randomBytes
import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.discovery.getDiscoveryProvider
import io.github.steve02081504.fountp2p.discovery.nostr.NOSTR_SIGNAL_KIND
import io.github.steve02081504.fountp2p.discovery.nostr.resolveNostrRelayUrls
import io.github.steve02081504.fountp2p.discovery.sendNodeSignalPacket
import io.github.steve02081504.fountp2p.node.nodeDebug
import io.github.steve02081504.fountp2p.node.shortHash
import io.github.steve02081504.fountp2p.link.FRAME_HEADER_BYTES
import io.github.steve02081504.fountp2p.link.LinkPipeOptions
import io.github.steve02081504.fountp2p.link.asLinkHandle
import io.github.steve02081504.fountp2p.link.maxFrameChunkBytesForPayload
import io.github.steve02081504.fountp2p.link.providers.LINK_LEVEL_NOSTR
import io.github.steve02081504.fountp2p.link.providers.LinkHandle
import io.github.steve02081504.fountp2p.link.providers.LinkProvider
import io.github.steve02081504.fountp2p.link.providers.createLinkIdBoundPipe
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import io.github.steve02081504.fountp2p.utils.LruMap
import io.github.steve02081504.fountp2p.utils.ms

/**
 * 单包 payload（UTF-8 / base64）上限，避免撞 relay content 限制。
 *
 * **差异（deferred）**：JS 会经 NIP-11 `max_message_length` 实测覆盖此默认值；
 * Kotlin 侧暂不探测（保持默认），KDoc 标注。
 */
const val MAX_LINK_PAYLOAD_CHARS = 131072

private const val NOSTR_HANDSHAKE_TIMEOUT_MS = 30_000L
private const val NOSTR_HEARTBEAT_MS = 60_000L
private const val NOSTR_IDLE_TIMEOUT_MS = 180_000L
private const val PENDING_PACKETS_MAX = 32

/** 固定 64 位 hex 占位。 */
private val HEX64 = "a".repeat(64)

/** AES-GCM 封装输出中的固定长度字段占位。 */
private val GCM_IV_BASE64 = "a".repeat(16)
private val GCM_AUTH_TAG_BASE64 = "a".repeat(24)

/**
 * 估算把给定 link 包发布为 Nostr EVENT 后，完整 WebSocket 消息的 UTF-8 字节长度。
 * @param packet link 包
 * @return 完整消息字节长度
 */
fun estimateEventMessageBytes(packet: Map<String, Any?>): Int {
	val packetJson = Json.stringify(packet) ?: "null"
	val envelope = linkedMapOf<String, Any?>(
		"iv" to GCM_IV_BASE64,
		"authTag" to GCM_AUTH_TAG_BASE64,
		"ciphertext" to bytesToBase64(packetJson.toByteArray(Charsets.UTF_8)),
	)
	val event = linkedMapOf<String, Any?>(
		"id" to HEX64,
		"pubkey" to HEX64,
		"created_at" to Math.floor(System.currentTimeMillis() / 1000.0),
		"kind" to NOSTR_SIGNAL_KIND.toDouble(),
		"tags" to listOf(listOf("t", HEX64), listOf("x", "signal"), listOf("p", HEX64)),
		"content" to bytesToBase64((Json.stringify(envelope) ?: "null").toByteArray(Charsets.UTF_8)),
		"sig" to HEX64,
	)
	return (Json.stringify(listOf("EVENT", event)) ?: "null").toByteArray(Charsets.UTF_8).size
}

/** relay cap 低于此字符数视为无法承载最小正 chunk。 */
val MIN_USABLE_RELAY_CAP_CHARS: Int = estimateEventMessageBytes(
	mapOf(
		"type" to "link",
		"op" to "b",
		"from" to HEX64,
		"linkId" to HEX64,
		"payload" to bytesToBase64(ByteArray(FRAME_HEADER_BYTES + 1)),
	),
)

/**
 * 从各 relay 上报的 cap 中取「可用」的非零最小值。
 * @param caps 各 relay 上报的 cap
 * @return 可用最小值；无可用 relay 返回 null
 */
fun minUsablePayloadCap(caps: List<Double?>): Double? {
	val usable = caps.filter { it != null && !it.isNaN() && !it.isInfinite() && it >= MIN_USABLE_RELAY_CAP_CHARS }.filterNotNull()
	return usable.minOrNull()
}

private val nostrLinkScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

private class NostrLinkSession(	val pipe: io.github.steve02081504.fountp2p.link.LinkPipe,
	val remoteNodeHash: String,
	val initiator: Boolean,
)

/**
 * Nostr 末位数据链路 provider。
 * @param options 中继解析（测试可注入）
 */
class NostrLinkProvider(options: Map<String, Any?> = emptyMap()) : LinkProvider {
	@Suppress("UNCHECKED_CAST")
	private val resolveRelayUrlsOverride = options["getRelayUrls"] as? (() -> List<String>)
	private var onInbound: ((LinkHandle) -> Unit)? = null
	private var localIdentity: Map<String, Any?>? = null
	private val sessions = LinkedHashMap<String, NostrLinkSession>()
	private val pendingByLinkId = LruMap<String, MutableList<Map<String, Any?>>>(64)

	private fun resolveRelayUrls(): List<String> = resolveRelayUrlsOverride?.invoke() ?: resolveNostrRelayUrls()

	override val id: String = "nostr"
	override val level: Double = LINK_LEVEL_NOSTR
	override val caps: Map<String, Any?> = mapOf("needsOfferAnswer" to false, "needsDiscoverySignal" to false, "probe" to "sync")

	override suspend fun isAvailable(): Boolean {
		if (getDiscoveryProvider("nostr") == null) return false
		return resolveRelayUrls().isNotEmpty()
	}

	override fun canReach(remote: Map<String, Any?>): Boolean = getDiscoveryProvider("nostr") != null

	private fun currentMaxPayloadChars(): Int = MAX_LINK_PAYLOAD_CHARS

	/** NIP-11 payload 上限探测：Kotlin 侧 deferred（保持默认上限）。 */
	private suspend fun refreshPayloadCap(relayUrls: List<String>) {
		// deferred: NIP-11 max_message_length probing
	}

	private fun applySessionPacket(session: NostrLinkSession, packet: Map<String, Any?>) {
		when (packet["op"]?.toString() ?: "") {
			"close" -> {
				nostrLinkScope.launch { session.pipe.close("remote-close") }
			}
			"c" -> {
				val payload = packet["payload"] as? String ?: return
				session.pipe.handleInbound(payload)
			}
			"b" -> {
				val payload = packet["payload"] as? String ?: return
				try {
					session.pipe.handleInbound(base64ToBytes(payload))
				}
				catch (_: Exception) {
					// drop malformed
				}
			}
		}
	}

	private fun bufferPending(linkId: String, packet: Map<String, Any?>) {
		val list = pendingByLinkId.get(linkId) ?: ArrayList<Map<String, Any?>>().also { pendingByLinkId.touch(linkId, it) }
		if (list.size >= PENDING_PACKETS_MAX) list.removeAt(0)
		list.add(packet)
	}

	private suspend fun sendOp(remoteNodeHash: String, linkId: String, op: String, payload: String? = null, maxChars: Int = MAX_LINK_PAYLOAD_CHARS) {
		val packet = LinkedHashMap<String, Any?>()
		packet["type"] = "link"
		packet["op"] = op
		packet["from"] = localIdentity?.get("nodeHash")?.toString() ?: ""
		packet["linkId"] = linkId
		if (payload != null) packet["payload"] = payload
		if (estimateEventMessageBytes(packet) > maxChars) throw IllegalStateException("p2p: nostr link payload too large")
		sendNodeSignalPacket(remoteNodeHash, packet)
	}

	private fun openPipe(opts: Map<String, Any?>): io.github.steve02081504.fountp2p.link.LinkPipe {
		val linkId = opts["linkId"].toString()
		val remoteNodeHash = opts["remoteNodeHash"].toString()
		val initiator = opts["initiator"] == true
		val payloadChars = currentMaxPayloadChars()
		val maxFrameBytes = maxFrameChunkBytesForPayload(
			payloadChars,
			encode = { frameBytes ->
				"x".repeat(
					estimateEventMessageBytes(
						mapOf(
							"type" to "link",
							"op" to "b",
							"from" to ((opts["localIdentity"] as? Map<*, *>)?.get("nodeHash")?.toString()
								?: localIdentity?.get("nodeHash")?.toString() ?: ""),
							"linkId" to linkId,
							"payload" to bytesToBase64(frameBytes),
						),
					),
				)
			},
		)
		val effectiveIdentity = (opts["localIdentity"] as? Map<String, Any?>) ?: localIdentity
		val pipe = createLinkIdBoundPipe(
			LinkPipeOptions(
				providerId = "nostr",
				level = LINK_LEVEL_NOSTR,
				initiator = initiator,
				nodeHash = remoteNodeHash,
				localIdentity = effectiveIdentity,
				maxFrameBytes = maxFrameBytes,
				handshakeTimeoutMs = NOSTR_HANDSHAKE_TIMEOUT_MS,
				heartbeatMs = NOSTR_HEARTBEAT_MS,
				idleTimeoutMs = NOSTR_IDLE_TIMEOUT_MS,
				sendControlText = { text -> sendOp(remoteNodeHash, linkId, "c", text, payloadChars) },
				sendFrame = { _, frame -> sendOp(remoteNodeHash, linkId, "b", bytesToBase64(frame), payloadChars) },
				closeTransport = {
					sessions.remove(linkId)
					try {
						sendOp(remoteNodeHash, linkId, "close")
					}
					catch (_: Exception) {
						// ignore
					}
				},
			),
			linkId,
		)
		sessions[linkId] = NostrLinkSession(pipe, remoteNodeHash, initiator)
		pipe.onDown { sessions.remove(linkId) }
		return pipe
	}

	/**
	 * 入站已解密的 link 包（由信令 demux 调用）。
	 * @param packet link 包
	 */
	suspend fun deliverPacket(packet: Map<String, Any?>?) {
		if (packet?.get("type") != "link") return
		val linkId = isHex64(packet["linkId"]) ?: return
		val from = isHex64(packet["from"]) ?: return
		if (localIdentity?.get("nodeHash")?.toString() == from) return
		val op = packet["op"]?.toString() ?: ""
		if (op == "open") {
			if (sessions.containsKey(linkId)) return
			val inbound = onInbound
			val identity = localIdentity
			if (inbound == null || identity == null) {
				// 监听未挂上（例如通道关掉再打开后 registry 没重新 ensureListening）时入站包会被丢弃；
				// 静默丢弃曾让「对端明明在线却始终握手超时」无法诊断（见 fount-p2p#38）。
				nodeDebug(
					"p2p:nostr link-open dropped — listener not attached",
					linkedMapOf("peer" to shortHash(from), "linkId" to shortHash(linkId)),
				)
				return
			}
			refreshPayloadCap(resolveRelayUrls())
			if (sessions.containsKey(linkId)) return
			val pipe = openPipe(mapOf("linkId" to linkId, "remoteNodeHash" to from, "initiator" to false, "localIdentity" to identity))
			inbound(asLinkHandle(pipe))
			nostrLinkScope.launch {
				try {
					pipe.startHandshake()
				}
				catch (_: Exception) {
					sessions.remove(linkId)
					pipe.close("accept-failed")
				}
			}
			val pending = pendingByLinkId.get(linkId) ?: emptyList()
			pendingByLinkId.remove(linkId)
			val session = sessions[linkId]
			if (session != null) for (queued in pending) applySessionPacket(session, queued)
			return
		}
		val session = sessions[linkId]
		if (session == null) {
			if (op == "c" || op == "b" || op == "close") bufferPending(linkId, packet)
			return
		}
		applySessionPacket(session, packet)
	}

	override suspend fun dial(options: Map<String, Any?>): LinkHandle? {
		if (!isAvailable()) return null
		val remoteNodeHash = options["nodeHash"]?.toString() ?: return null
		if (isHex64(remoteNodeHash) == null) return null
		localIdentity = (options["localIdentity"] as? Map<String, Any?>) ?: localIdentity
		val identity = localIdentity ?: throw IllegalStateException("p2p: nostr dial requires localIdentity")
		if (identity["nodeHash"]?.toString().isNullOrEmpty()) throw IllegalStateException("p2p: nostr dial requires localIdentity")
		refreshPayloadCap(resolveRelayUrls())
		val linkId = bytesToHex(randomBytes(32))
		val pipe = openPipe(mapOf("linkId" to linkId, "remoteNodeHash" to remoteNodeHash, "initiator" to true, "localIdentity" to identity))
		sendOp(remoteNodeHash, linkId, "open")
		pipe.startHandshake()
		return asLinkHandle(pipe)
	}

	override suspend fun ensureListening(onInbound: (LinkHandle) -> Unit, localIdentity: Map<String, Any?>): () -> Unit {
		this.onInbound = onInbound
		this.localIdentity = localIdentity
		return {
			this.onInbound = null
			for (session in sessions.values.toList()) nostrLinkScope.launch { session.pipe.close("listen-stop") }
			sessions.clear()
			pendingByLinkId.clear()
		}
	}
}

/**
 * 创建 Nostr 末位数据链路 provider（level = -Infinity）。
 * @param options 中继解析（测试可注入）
 * @return provider
 */
@JvmOverloads
fun createNostrLinkProvider(options: Map<String, Any?> = emptyMap()): NostrLinkProvider = NostrLinkProvider(options)
