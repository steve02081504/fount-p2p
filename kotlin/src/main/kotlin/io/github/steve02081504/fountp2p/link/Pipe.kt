package io.github.steve02081504.fountp2p.link

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.JsonUndefined
import io.github.steve02081504.fountp2p.core.toBytes
import io.github.steve02081504.fountp2p.link.providers.LinkHandle
import io.github.steve02081504.fountp2p.utils.LruMap
import io.github.steve02081504.fountp2p.utils.emitSafe
import io.github.steve02081504.fountp2p.utils.ms
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** RTT 样本滑动窗口大小。 */
private const val RTT_WINDOW_SIZE = 10

/** 未收到 pong 的 ping 记录保留时长。 */
private const val PING_RECORD_TTL_MS = 30000L

/** 可取消的定时任务。 */
interface LinkTimerTask {
	/** 取消任务。 */
	fun cancel()
}

/** 定时调度抽象（测试可注入假调度器，避免真实 sleep）。 */
interface LinkScheduler {
	/**
	 * @param delayMs 首次延迟
	 * @param periodMs 周期（null 表示一次性）
	 * @param task 任务
	 * @return 可取消句柄
	 */
	fun schedule(delayMs: Long, periodMs: Long?, task: () -> Unit): LinkTimerTask
}

/** 基于 coroutines 的默认调度器。 */
class CoroutineLinkScheduler(private val scope: CoroutineScope) : LinkScheduler {
	override fun schedule(delayMs: Long, periodMs: Long?, task: () -> Unit): LinkTimerTask {
		val job = scope.launch {
			if (delayMs > 0) kotlinx.coroutines.delay(delayMs)
			while (true) {
				task()
				if (periodMs == null) break
				kotlinx.coroutines.delay(periodMs)
			}
		}
		return object : LinkTimerTask {
			override fun cancel() {
				job.cancel()
			}
		}
	}
}

/** `createLinkPipe` 配置。 */
class LinkPipeOptions(
	val providerId: String,
	val level: Double,
	val initiator: Boolean,
	val nodeHash: String? = null,
	val localIdentity: Map<String, Any?>? = null,
	val getLocalBinding: () -> String? = { null },
	val getRemoteBinding: () -> String? = { null },
	val sendControlText: suspend (String) -> Unit = {},
	val sendFrame: suspend (String, ByteArray) -> Unit = { _, _ -> },
	val closeTransport: (suspend () -> Unit)? = null,
	val extraStats: (() -> Map<String, Any?>)? = null,
	val heartbeatMs: Long = ms("15s"),
	val idleTimeoutMs: Long = ms("45s"),
	val handshakeTimeoutMs: Long = ms("10s"),
	val rttWindowSize: Int = RTT_WINDOW_SIZE,
	val maxFrameBytes: Int? = null,
	val scheduler: LinkScheduler? = null,
	val scope: CoroutineScope? = null,
	val now: () -> Long = { System.currentTimeMillis() },
) {
	/**
	 * @param localBinding 本地 binding 覆盖
	 * @param remoteBinding 远端 binding 覆盖
	 * @return 覆盖 binding 后的新配置
	 */
	fun withBindings(localBinding: () -> String?, remoteBinding: () -> String?): LinkPipeOptions = LinkPipeOptions(
		providerId = providerId,
		level = level,
		initiator = initiator,
		nodeHash = nodeHash,
		localIdentity = localIdentity,
		getLocalBinding = localBinding,
		getRemoteBinding = remoteBinding,
		sendControlText = sendControlText,
		sendFrame = sendFrame,
		closeTransport = closeTransport,
		extraStats = extraStats,
		heartbeatMs = heartbeatMs,
		idleTimeoutMs = idleTimeoutMs,
		handshakeTimeoutMs = handshakeTimeoutMs,
		rttWindowSize = rttWindowSize,
		maxFrameBytes = maxFrameBytes,
		scheduler = scheduler,
		scope = scope,
		now = now,
	)
}

/**
 * 在已打开的字节/控制双工上跑 hello/auth、分帧 envelope 与心跳（等价 JS `createLinkPipe`）。
 */
class LinkPipe(private val options: LinkPipeOptions) : LinkHandle {
	override val providerId: String = options.providerId
	override val level: Double = options.level
	private val maxFrameBytes = options.maxFrameBytes ?: DEFAULT_MAX_FRAME_CHUNK_BYTES
	private val heartbeatMs = options.heartbeatMs
	private val idleTimeoutMs = options.idleTimeoutMs
	private val handshakeTimeoutMs = options.handshakeTimeoutMs
	private val targetNodeHash = options.nodeHash ?: ""

	private val scope: CoroutineScope = options.scope ?: CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
	private val scheduler: LinkScheduler = options.scheduler ?: CoroutineLinkScheduler(scope)
	private val now = options.now

	private var closed = false
	private var readyFlag = false
	private var closeReason = "closed"
	private var remoteNodeHash: String? = if (targetNodeHash.isEmpty()) null else targetNodeHash
	private var remoteHello: Map<String, Any?>? = null
	private var localHello: Map<String, Any?>? = null
	private var handshakeTimer: LinkTimerTask? = null
	private var idleTimer: LinkTimerTask? = null
	private var heartbeatTimer: LinkTimerTask? = null
	private var helloSent = false
	private var authSent = false
	private var remoteAuthVerified = false
	private var pendingAuth: Map<String, Any?>? = null
	private var lastInboundAt = now()
	private var lastOutboundAt = 0L
	private var sentFrames = 0
	private var recvFrames = 0
	private val rttWindowSize = maxOf(2, options.rttWindowSize)
	private var pingSeq = 0
	private val outstandingPings = LinkedHashMap<Double, Long>()
	private var rttMs: Double? = null
	private var avgRttMs: Long? = null
	private var minRttMs: Double? = null
	private var maxRttMs: Double? = null
	private var pingCount = 0
	private var pongCount = 0
	private val rttSamples = ArrayList<Double>()
	private val rttListeners = LinkedHashSet<(Double) -> Unit>()
	private val envelopeListeners = LinkedHashSet<(Map<String, Any?>, String) -> Unit>()
	private val downListeners = LinkedHashSet<(String) -> Unit>()
	private val completedFrameIds = LruMap<String, Boolean>(4096)
	private val reassembler = Reassembler()

	override val ready: CompletableDeferred<Unit> = CompletableDeferred()

	init {
		if (options.maxFrameBytes != null && maxFrameBytes < FRAME_HEADER_BYTES)
			throw IllegalArgumentException("p2p: $providerId maxFrameBytes too small to carry a frame header")
	}

	private suspend fun sendRawControl(body: Map<String, Any?>) {
		val out = LinkedHashMap<String, Any?>()
		out["type"] = if (body.containsKey("sig")) "auth" else "hello"
		out.putAll(body)
		options.sendControlText(Json.stringify(out) ?: "null")
		lastOutboundAt = now()
	}

	/** binding 就绪后向对端发送 auth。 */
	suspend fun maybeSendAuth() {
		if (authSent || remoteHello == null) return
		val binding = options.getLocalBinding() ?: return
		authSent = true
		sendRawControl(buildAuth(remoteHello!!["nonce"] as? String, binding, options.localIdentity ?: emptyMap()))
	}

	private suspend fun maybeFinishHandshake() {
		if (readyFlag || remoteHello == null || !remoteAuthVerified) return
		readyFlag = true
		handshakeTimer?.cancel()
		heartbeatTimer = scheduler.schedule(heartbeatMs, heartbeatMs) {
			pingCount++
			val seq = pingSeq++
			val ts = now()
			val cutoff = ts - PING_RECORD_TTL_MS
			val stale = outstandingPings.filterValues { it < cutoff }.keys
			for (key in stale) outstandingPings.remove(key)
			outstandingPings[seq.toDouble()] = ts
			scope.launch {
				runCatching { send(mapOf("scope" to "link", "action" to "ping", "payload" to linkedMapOf("ts" to ts.toDouble(), "seq" to seq.toDouble()))) }
			}
		}
		idleTimer = scheduler.schedule(maxOf(1000L, heartbeatMs / 3), maxOf(1000L, heartbeatMs / 3)) {
			if (now() - lastInboundAt > idleTimeoutMs) scope.launch { close("idle-timeout") }
		}
		ready.complete(Unit)
	}

	private suspend fun handleAuth(auth: Map<String, Any?>) {
		if (remoteHello == null) {
			pendingAuth = auth
			return
		}
		val binding = options.getRemoteBinding()
		val verifiedNodeHash = verifyAuth(remoteHello, auth, localHello?.get("nonce") as? String, binding)
		if (verifiedNodeHash == null) {
			close("auth-failed:binding=${binding ?: "missing"} localNonce=${localHello?.get("nonce") ?: "missing"}")
			return
		}
		if (targetNodeHash.isNotEmpty() && verifiedNodeHash != targetNodeHash) {
			close("nodehash-mismatch")
			return
		}
		remoteNodeHash = verifiedNodeHash
		remoteAuthVerified = true
		maybeFinishHandshake()
	}

	private suspend fun handleControlMessage(message: Any?) {
		val obj = message as? Map<*, *> ?: return
		if (obj["type"] == "hello") {
			val parsed = parseHello(obj)
			if (parsed == null) {
				close("hello-invalid")
				return
			}
			remoteHello = parsed
			maybeSendAuth()
			val pending = pendingAuth
			if (pending != null) {
				pendingAuth = null
				handleAuth(pending)
			}
			return
		}
		if (obj["type"] == "auth") {
			@Suppress("UNCHECKED_CAST")
			handleAuth(obj as Map<String, Any?>)
		}
	}

	private fun handleBinaryFrame(bytes: ByteArray) {
		try {
			recvFrames++
			val merged = reassembler.push(bytes) ?: return
			val envelope = Json.parse(String(merged, Charsets.UTF_8)) as? Map<*, *> ?: return
			val frameId = envelope["frameId"] as? String
			if (frameId != null && completedFrameIds.contains(frameId)) return
			if (frameId != null) completedFrameIds.touch(frameId, true)
			if (envelope["scope"] == "link") {
				@Suppress("UNCHECKED_CAST")
				val payloadMap = envelope["payload"] as? Map<String, Any?>
				if (envelope["action"] == "ping") {
					val pingPayload = payloadMap ?: emptyMap()
					scope.launch {
						runCatching {
							send(
								mapOf(
									"scope" to "link",
									"action" to "pong",
									"payload" to linkedMapOf("ts" to pingPayload["ts"], "seq" to pingPayload["seq"]),
								),
							)
						}
					}
					return
				}
				if (envelope["action"] == "pong") {
					val pongPayload = payloadMap ?: emptyMap()
					val seqValue = (pongPayload["seq"] as? Number)?.toDouble()
					val tsValue = (pongPayload["ts"] as? Number)?.toDouble()
					val sentTs = if (seqValue != null) outstandingPings[seqValue] else null
					if (tsValue != null && !tsValue.isNaN() && sentTs != null && sentTs.toDouble() == tsValue) {
						outstandingPings.remove(seqValue)
						pongCount++
						val sample = (now() - sentTs).toDouble()
						if (sample >= 0) {
							rttMs = sample
							rttSamples.add(sample)
							if (rttSamples.size > rttWindowSize) rttSamples.removeAt(0)
							avgRttMs = Math.round(rttSamples.sum() / rttSamples.size)
							minRttMs = rttSamples.minOrNull()
							maxRttMs = rttSamples.maxOrNull()
							emitSafe(
								rttListeners.map { listener -> { args: Array<out Any?> -> listener(args[0] as Double) } },
								sample,
							)
						}
					}
					return
				}
			}
			@Suppress("UNCHECKED_CAST")
			val remote = remoteNodeHash
			if (readyFlag && remote != null) {
				val envelopeTyped = envelope as Map<String, Any?>
				emitSafe(
					envelopeListeners.map { listener -> { args: Array<out Any?> -> listener(args[0] as Map<String, Any?>, args[1] as String) } },
					envelopeTyped,
					remote,
				)
			}
		}
		catch (_: Exception) {
			// drop malformed network ingress
		}
	}

	/**
	 * 统一入站：JSON control 或二进制帧。
	 * @param data 原始数据
	 */
	fun handleInbound(data: Any?) {
		lastInboundAt = now()
		if (data is String) {
			if (data.startsWith("{")) {
				val parsed = runCatching { Json.parse(data) }.getOrNull()
				if (parsed != null) {
					scope.launch { handleControlMessage(parsed) }
					return
				}
			}
			try {
				handleBinaryFrame(data.toByteArray(Charsets.UTF_8))
			}
			catch (_: Exception) {
				// ignore
			}
			return
		}
		val bytes = try {
			toBytes(data, allowString = true)
		}
		catch (_: Exception) {
			return
		}
		try {
			val text = String(bytes, Charsets.UTF_8)
			if (text.startsWith("{")) {
				val parsed = runCatching { Json.parse(text) }.getOrNull()
				if (parsed != null) {
					scope.launch { handleControlMessage(parsed) }
					return
				}
			}
		}
		catch (_: Exception) {
			// binary path
		}
		handleBinaryFrame(bytes)
	}

	/** 传输就绪后启动握手（发 hello）。 */
	suspend fun startHandshake() {
		if (helloSent || closed) return
		handshakeTimer = scheduler.schedule(handshakeTimeoutMs, null) { scope.launch { close("handshake-timeout") } }
		helloSent = true
		localHello = buildHello(options.localIdentity ?: emptyMap())
		sendRawControl(localHello!!)
		maybeSendAuth()
	}

	override suspend fun send(envelope: Map<String, Any?>): Boolean {
		ready.await()
		if (closed) return false
		val frameId = randomFrameIdHex()
		val payload = envelope["payload"]?.let { if (it === JsonUndefined) null else it }
		val body = LinkedHashMap<String, Any?>()
		body["scope"] = envelope["scope"]
		body["action"] = envelope["action"]
		body["payload"] = payload ?: null
		body["frameId"] = frameId
		val bytes = (Json.stringify(body) ?: "null").toByteArray(Charsets.UTF_8)
		for (frame in encodeFrames(frameId, bytes, maxFrameBytes)) {
			options.sendFrame(envelope["action"] as? String ?: "", frame)
			sentFrames++
		}
		lastOutboundAt = now()
		return true
	}

	override suspend fun close(reason: String) {
		if (closed) return
		closed = true
		closeReason = reason
		handshakeTimer?.cancel()
		heartbeatTimer?.cancel()
		idleTimer?.cancel()
		try {
			options.closeTransport?.invoke()
		}
		catch (_: Exception) {
			// ignore
		}
		if (!readyFlag && !ready.isCompleted) ready.completeExceptionally(IllegalStateException("p2p: link closed before ready ($reason)"))
		emitSafe(downListeners.map { listener -> { args: Array<out Any?> -> listener(args[0] as String) } }, reason)
	}

	override val nodeHash: String? get() = remoteNodeHash
	override val initiator: Boolean get() = options.initiator

	override fun onEnvelope(callback: (Map<String, Any?>, String) -> Unit): () -> Unit {
		envelopeListeners.add(callback)
		return { envelopeListeners.remove(callback); Unit }
	}

	override fun onDown(callback: (String) -> Unit): () -> Unit {
		downListeners.add(callback)
		return { downListeners.remove(callback); Unit }
	}

	/**
	 * @param callback RTT 样本回调
	 * @return 取消订阅
	 */
	fun onRtt(callback: (Double) -> Unit): () -> Unit {
		rttListeners.add(callback)
		return { rttListeners.remove(callback); Unit }
	}

	override fun stats(): Map<String, Any?> {
		val out = LinkedHashMap<String, Any?>()
		out["ready"] = readyFlag
		out["providerId"] = providerId
		out["level"] = level
		out["nodeHash"] = remoteNodeHash
		out["targetNodeHash"] = if (targetNodeHash.isEmpty()) null else targetNodeHash
		out["initiator"] = options.initiator
		out["lastInboundAt"] = lastInboundAt.toDouble()
		out["lastOutboundAt"] = lastOutboundAt.toDouble()
		out["sentFrames"] = sentFrames.toDouble()
		out["recvFrames"] = recvFrames.toDouble()
		out["rttMs"] = rttMs
		out["avgRttMs"] = avgRttMs?.toDouble()
		out["minRttMs"] = minRttMs
		out["maxRttMs"] = maxRttMs
		out["pingCount"] = pingCount.toDouble()
		out["pongCount"] = pongCount.toDouble()
		out["closeReason"] = closeReason
		options.extraStats?.invoke()?.let { out.putAll(it) }
		return out
	}
}

/**
 * 把 createLinkPipe 句柄收成上层 LinkHandle（可附带测试/内部字段覆盖 stats）。
 * @param pipe pipe 句柄
 * @param extras 额外字段（覆盖同名 stats）
 * @return LinkHandle
 */
@JvmOverloads
fun asLinkHandle(pipe: LinkPipe, extras: Map<String, Any?> = emptyMap()): LinkHandle = object : LinkHandle by pipe {
	override fun stats(): Map<String, Any?> {
		val out = LinkedHashMap<String, Any?>(pipe.stats())
		out.putAll(extras)
		return out
	}
}
