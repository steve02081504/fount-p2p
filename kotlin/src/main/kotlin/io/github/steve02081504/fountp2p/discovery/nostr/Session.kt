package io.github.steve02081504.fountp2p.discovery.nostr

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.base64ToBytes
import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.crypto.randomBytes
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull

/** WebSocket readyState 常量（与浏览器/ws 一致）。 */
const val WS_CONNECTING = 0
const val WS_OPEN = 1
const val WS_CLOSING = 2
const val WS_CLOSED = 3

/** 单中继 WebSocket 首连超时。 */
const val NOSTR_CONNECT_TIMEOUT_MS = 2_000L

/** 单 relay 等待 EVENT OK 回执超时。 */
const val NOSTR_PUBLISH_OK_TIMEOUT_MS = 3_000L

/** 共享 relay 会话断线后重连间隔。 */
private const val NOSTR_RECONNECT_DELAY_MS = 500L

/** 无 sub/publish 工作时共享 relay 空闲回收延迟。 */
private const val NOSTR_IDLE_DROP_MS = 2_000L

/** 已解析的连接目标（钉 IP 用）。 */
data class RelayConnectTarget(val hostname: String, val addresses: List<String>)

/**
 * WebSocket 抽象（Android 端无 `ws`；由宿主注入 OkHttp/系统实现）。
 */
interface WebSocketConnection {
	/** 当前 readyState（[WS_CONNECTING] / [WS_OPEN] / [WS_CLOSING] / [WS_CLOSED]）。 */
	val readyState: Int

	/** 入站文本消息回调。 */
	var onMessage: ((String) -> Unit)?

	/** 关闭回调。 */
	var onClose: (() -> Unit)?

	/** 错误回调。 */
	var onError: (() -> Unit)?

	/**
	 * 发送文本。
	 * @param text 文本
	 */
	fun send(text: String)

	/** 优雅关闭。 */
	fun close()

	/** 强制终止。 */
	fun terminate()
}

/** WebSocket 连接工厂（Android 端以 OkHttp 等实现）。 */
interface WebSocketProvider {
	/**
	 * 建立到指定 URL 的连接并等待 open。
	 * @param url relay URL
	 * @param target 已解析的连接目标（钉 IP）
	 * @return 已打开连接
	 */
	suspend fun connect(url: String, target: RelayConnectTarget?): WebSocketConnection
}

private var webSocketProvider: WebSocketProvider? = null

/** @param provider WebSocket 连接工厂 */
fun setWebSocketProvider(provider: WebSocketProvider?) {
	webSocketProvider = provider
}

/** @return 当前 WebSocket 连接工厂 */
fun getWebSocketProvider(): WebSocketProvider? = webSocketProvider

/**
 * @param urls 原始列表
 * @return 去重后的列表
 */
fun dedupeRelayUrls(urls: List<String>?): List<String> {
	val seen = HashSet<String>()
	val out = ArrayList<String>()
	for (url in urls ?: emptyList()) {
		if (url.isEmpty() || seen.contains(url)) continue
		seen.add(url)
		out.add(url)
	}
	return out
}

/** 轻量取消信号（等价 JS `AbortSignal` 的最小面）。 */
class AbortSignalLike {
	@Volatile
	var aborted: Boolean = false
		private set
	private val listeners = LinkedHashSet<() -> Unit>()

	/** 触发取消并回调监听器。 */
	fun abort() {
		if (aborted) return
		aborted = true
		for (listener in listeners.toList()) listener()
		listeners.clear()
	}

	/**
	 * @param listener 取消回调
	 */
	fun addEventListener(listener: () -> Unit) {
		if (aborted) {
			listener()
			return
		}
		listeners.add(listener)
	}
}

private class RelaySub(
	val filter: Map<String, Any?>,
	val onEvent: (Map<String, Any?>, String) -> Unit,
)

private class PublishAttempt(
	val event: Map<String, Any?>,
	val signal: AbortSignalLike?,
	var attempt: Int,
	val deferred: CompletableDeferred<Boolean>,
)

private class SharedRelaySession(val url: String) {
	var connection: WebSocketConnection? = null
	var connectTarget: RelayConnectTarget? = null
	var connecting = false
	var reconnectJob: Job? = null
	var idleJob: Job? = null
	val subs = LinkedHashMap<String, RelaySub>()
	val pending = ArrayList<PublishAttempt>()
	val inflight = ArrayList<PublishAttempt>()

	fun hasPendingWork(): Boolean = subs.isNotEmpty() || pending.isNotEmpty() || inflight.isNotEmpty()
}

private val sessionScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
private val sessionMutex = Mutex()
private val sharedRelaySessions = LinkedHashMap<String, SharedRelaySession>()

private fun clearIdleDrop(session: SharedRelaySession) {
	session.idleJob?.cancel()
	session.idleJob = null
}

private fun clearReconnect(session: SharedRelaySession) {
	session.reconnectJob?.cancel()
	session.reconnectJob = null
}

private fun scheduleIdleDrop(session: SharedRelaySession) {
	if (session.subs.isNotEmpty() || session.idleJob != null) return
	session.idleJob = sessionScope.launch {
		delay(NOSTR_IDLE_DROP_MS)
		sessionMutex.withLock {
			session.idleJob = null
			if (sharedRelaySessions[session.url] !== session || session.hasPendingWork()) return@withLock
			sharedRelaySessions.remove(session.url)
			clearReconnect(session)
			session.connection?.let { runCatching { it.close() } }
			session.connection = null
		}
	}
}

private fun handleMessage(session: SharedRelaySession, text: String) {
	val parsed = try {
		Json.parse(text) as? List<*>
	}
	catch (_: Exception) {
		return
	}
	if (parsed == null || parsed.getOrNull(0) != "EVENT") return
	val subId = parsed.getOrNull(1)?.toString() ?: ""
	val event = parsed.getOrNull(2) as? Map<String, Any?> ?: return
	val sub = session.subs[subId] ?: return
	try {
		sub.onEvent(event, session.url)
	}
	catch (_: Exception) {
		// ignore
	}
}

private fun attachSocket(session: SharedRelaySession, ws: WebSocketConnection) {
	session.connection = ws
	ws.onMessage = { handleMessage(session, it) }
	ws.onClose = {
		sessionScope.launch {
			sessionMutex.withLock {
				if (sharedRelaySessions[session.url] !== session) return@withLock
				session.connection = null
				if (session.inflight.isNotEmpty()) {
					session.pending.addAll(session.inflight)
					session.inflight.clear()
				}
				if (!session.hasPendingWork()) {
					sharedRelaySessions.remove(session.url)
					return@withLock
				}
				scheduleReconnect(session, NOSTR_RECONNECT_DELAY_MS)
			}
		}
	}
	for ((subId, sub) in session.subs) {
		try {
			ws.send(Json.stringify(listOf("REQ", subId, sub.filter)) ?: "")
		}
		catch (_: Exception) {
			// ignore
		}
	}
	flushPending(session)
	if (!session.hasPendingWork()) scheduleIdleDrop(session)
}

private fun scheduleReconnect(session: SharedRelaySession, delayMs: Long = 0) {
	if (sharedRelaySessions[session.url] !== session || session.connecting || session.connection != null) return
	clearReconnect(session)
	val start: () -> Unit = {
		sessionScope.launch {
			sessionMutex.withLock {
				if (sharedRelaySessions[session.url] !== session || session.connecting || session.connection != null) return@withLock
				if (!session.hasPendingWork()) {
					sharedRelaySessions.remove(session.url)
					return@withLock
				}
				val provider = webSocketProvider
				if (provider == null) return@withLock
				session.connecting = true
				try {
					val ws = provider.connect(session.url, session.connectTarget)
					session.connecting = false
					if (sharedRelaySessions[session.url] !== session || !session.hasPendingWork()) {
						sharedRelaySessions.remove(session.url)
						runCatching { ws.terminate() }
						return@withLock
					}
					attachSocket(session, ws)
				}
				catch (_: Exception) {
					session.connecting = false
					if (sharedRelaySessions[session.url] !== session) return@withLock
					if (!session.hasPendingWork()) {
						sharedRelaySessions.remove(session.url)
						return@withLock
					}
					scheduleReconnect(session, NOSTR_RECONNECT_DELAY_MS)
				}
			}
		}
	}
	if (delayMs <= 0) start()
	else session.reconnectJob = sessionScope.launch {
		delay(delayMs)
		session.reconnectJob = null
		start()
	}
}

private suspend fun acquireSharedRelay(url: String, connectTarget: RelayConnectTarget?): SharedRelaySession =
	sessionMutex.withLock {
		val existing = sharedRelaySessions[url]
		if (existing != null) return@withLock existing
		val session = SharedRelaySession(url)
		session.connectTarget = connectTarget
		sharedRelaySessions[url] = session
		scheduleReconnect(session)
		session
	}

private fun flushPending(session: SharedRelaySession) {
	val ws = session.connection ?: return
	val pending = session.pending.toList()
	session.pending.clear()
	for (attempt in pending) {
		session.inflight.add(attempt)
		sessionScope.launch {
			val ok = try {
				publishEventOnRelay(ws, attempt)
			}
			catch (_: Exception) {
				false
			}
			sessionMutex.withLock {
				if (!session.inflight.remove(attempt)) return@withLock
				if (!attempt.deferred.isCompleted) attempt.deferred.complete(ok)
				if (!session.hasPendingWork()) scheduleIdleDrop(session)
			}
		}
	}
}

private suspend fun publishEventOnRelay(ws: WebSocketConnection, attempt: PublishAttempt): Boolean {
	if (attempt.signal?.aborted == true) throw IllegalStateException("nostr: aborted")
	return withTimeoutOrNull(NOSTR_PUBLISH_OK_TIMEOUT_MS) {
		val result = CompletableDeferred<Boolean>()
		val previousOnMessage = ws.onMessage
		ws.onMessage = { text ->
			previousOnMessage?.invoke(text)
			val parsed = try {
				Json.parse(text) as? List<*>
			}
			catch (_: Exception) {
				null
			}
			if (parsed?.getOrNull(0) == "OK" && parsed.getOrNull(1) == attempt.event["id"]) {
				if (!result.isCompleted) result.complete(parsed.getOrNull(2) == true)
			}
		}
		try {
			ws.send(Json.stringify(listOf("EVENT", attempt.event)) ?: "")
			result.await()
		}
		finally {
			ws.onMessage = previousOnMessage
		}
	} ?: false
}

/**
 * 连接到 relay（一次性连接，不走共享会话）。失败抛错。
 * @param relayUrl 中继 URL
 * @param timeoutMs 超时毫秒
 * @param signal 取消信号
 * @param connectTarget 钉 IP 用的连接目标
 * @return 已打开的 WebSocket
 */
@JvmOverloads
suspend fun connectRelay(
	relayUrl: String,
	timeoutMs: Long = NOSTR_CONNECT_TIMEOUT_MS,
	signal: AbortSignalLike? = null,
	connectTarget: RelayConnectTarget? = null,
): WebSocketConnection {
	if (signal?.aborted == true) throw IllegalStateException("nostr: aborted")
	val provider = webSocketProvider ?: throw IllegalStateException("nostr: websocket provider unavailable")
	return withTimeoutOrNull(timeoutMs) {
		provider.connect(relayUrl, connectTarget)
	} ?: throw IllegalStateException("nostr: connect timeout for $relayUrl")
}

/**
 * 通过共享 relay 会话发布 EVENT。
 *
 * 相对 JS 的简化：未实现断线自动重发；连接复用与 SUB 重放保留。
 * @param relayUrl 中继 URL
 * @param event 待发布事件
 * @param signal 取消信号
 * @param connectTarget 钉 IP 用的连接目标
 * @return relay 是否接受 EVENT
 */
@JvmOverloads
suspend fun publishViaSharedRelay(
	relayUrl: String,
	event: Map<String, Any?>,
	signal: AbortSignalLike? = null,
	connectTarget: RelayConnectTarget? = null,
): Boolean {
	if (signal?.aborted == true) throw IllegalStateException("nostr: aborted")
	val session = acquireSharedRelay(relayUrl, connectTarget)
	clearIdleDrop(session)
	val attempt = PublishAttempt(event, signal, 0, CompletableDeferred())
	session.pending.add(attempt)
	val ws = session.connection
	if (ws?.readyState == WS_OPEN) flushPending(session)
	else scheduleReconnect(session)
	return attempt.deferred.await()
}

/**
 * 按 rendezvous 键订阅 Nostr kind（topic 不导出）。多订阅共享每 URL 一条连接。
 * @param relayUrls 中继 URL 列表
 * @param kind 事件 kind
 * @param rendezvousKey rendezvous 键
 * @param tagX `x` 标签值
 * @param onPayload content 字节与 meta 回调
 * @param addressable 是否附 `d` 标签
 * @param resolveConnectTarget 连接目标解析
 * @return 取消订阅
 */
@JvmOverloads
fun subscribeNostrKind(
	relayUrls: List<String>?,
	kind: Int,
	rendezvousKey: String,
	tagX: String,
	onPayload: (ByteArray, Map<String, Any?>) -> Unit,
	addressable: Boolean = false,
	resolveConnectTarget: (suspend (String) -> RelayConnectTarget?)? = null,
): () -> Unit {
	val subscriptionId = bytesToHex(randomBytes(8))
	val filter = LinkedHashMap<String, Any?>()
	filter["kinds"] = listOf(kind.toDouble())
	filter["#t"] = listOf(rendezvousKey)
	filter["#x"] = listOf(tagX)
	if (addressable) filter["#d"] = listOf(rendezvousKey)
	fun deliver(nostrEvent: Map<String, Any?>, relayUrl: String) {
		if (nostrEvent["kind"] != kind.toDouble()) return
		try {
			val content = nostrEvent["content"] as? String ?: return
			onPayload(base64ToBytes(content), linkedMapOf("relayUrl" to relayUrl, "event" to nostrEvent))
		}
		catch (_: Exception) {
			// ignore
		}
	}
	val onEvent: (Map<String, Any?>, String) -> Unit = ::deliver
	val urls = dedupeRelayUrls(relayUrls)
	for (relayUrl in urls)
		sessionScope.launch {
			val target = resolveConnectTarget?.invoke(relayUrl)
			val session = acquireSharedRelay(relayUrl, target)
			session.subs[subscriptionId] = RelaySub(filter, onEvent)
			clearIdleDrop(session)
			val ws = session.connection
			if (ws?.readyState == WS_OPEN) {
				try {
					ws.send(Json.stringify(listOf("REQ", subscriptionId, filter)) ?: "")
				}
				catch (_: Exception) {
					// ignore
				}
			}
			else scheduleReconnect(session)
		}
	return {
		for (relayUrl in urls)
			sessionScope.launch {
				sessionMutex.withLock {
					val session = sharedRelaySessions[relayUrl] ?: return@withLock
					session.subs.remove(subscriptionId)
					val ws = session.connection
					if (ws?.readyState == WS_OPEN) {
						try {
							ws.send(Json.stringify(listOf("CLOSE", subscriptionId)) ?: "")
						}
						catch (_: Exception) {
							// ignore
						}
					}
					if (session.hasPendingWork()) return@withLock
					sharedRelaySessions.remove(relayUrl)
					clearReconnect(session)
					clearIdleDrop(session)
					session.connection?.let { runCatching { it.close() } }
				}
			}
	}
}
