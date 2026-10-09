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
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.coroutineContext
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

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

/**
 * 已入队 publish 的等待上限（从入队起算，覆盖多次「连不上 → 退避重连」）。
 * 连接超时 2s + 重连间隔 0.5s ≈ 2.5s/轮，20s 约等于 8 轮；连不上的 relay 必须结算，
 * 否则请求永久留在 pending 里（见 fount-p2p#37）。
 */
const val NOSTR_QUEUED_PUBLISH_DEADLINE_MS = 20_000L

/** 测试可缩短的入队 publish 等待上限。 */
@Volatile
private var queuedPublishDeadlineMs = NOSTR_QUEUED_PUBLISH_DEADLINE_MS

/**
 * 覆盖入队 publish 等待上限（测试用；传 null 恢复默认）。
 * @param value 毫秒上限；null 恢复默认
 */
fun setQueuedPublishDeadlineMsForTests(value: Long?) {
	queuedPublishDeadlineMs = value ?: NOSTR_QUEUED_PUBLISH_DEADLINE_MS
}

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
		val callbacks = synchronized(listeners) {
			if (aborted) return
			aborted = true
			listeners.toList().also { listeners.clear() }
		}
		for (listener in callbacks) listener()
	}

	/**
	 * @param listener 取消回调
	 */
	fun addEventListener(listener: () -> Unit) {
		val alreadyAborted = synchronized(listeners) {
			if (aborted) true
			else {
				listeners.add(listener)
				false
			}
		}
		if (alreadyAborted) listener()
	}

	/** 移除已完成请求的取消回调。 */
	fun removeEventListener(listener: () -> Unit) {
		synchronized(listeners) { listeners.remove(listener) }
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
) {
	/** 入队等待上限定时器（已 flush 到 open socket 时为 null）。 */
	var deadlineJob: Job? = null
}

private class SharedRelaySession(val url: String) {
	var connection: WebSocketConnection? = null
	var connectTarget: RelayConnectTarget? = null
	var connecting = false
	var reconnectJob: Job? = null
	var idleJob: Job? = null

	/** 进行中的连接协程（持 sessionMutex 等宿主 connect；清理时必须取消它，否则锁被一直占住）。 */
	var connectJob: Job? = null
	val subs = LinkedHashMap<String, RelaySub>()
	val pending = ArrayList<PublishAttempt>()
	val inflight = ArrayList<PublishAttempt>()
	val publishAcks = ConcurrentHashMap<Pair<WebSocketConnection, String>, CopyOnWriteArrayList<CompletableDeferred<Boolean>>>()

	fun hasPendingWork(): Boolean = subs.isNotEmpty() || pending.isNotEmpty() || inflight.isNotEmpty()
}

private val sessionScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
private val sessionMutex = Mutex()
private val sharedRelaySessions = LinkedHashMap<String, SharedRelaySession>()

/**
 * 清空共享 relay 会话（测试用：避免上一个用例的退避重连循环泄漏到下一个用例）。
 *
 * 不取 [sessionMutex]：重连循环会持锁等宿主 connect，测试收尾不该被它拖住。
 * 取消重连/空闲定时器并让残留的入队请求结算即可。
 */
fun clearSharedRelaySessionsForTests() {
	val sessions = sharedRelaySessions.values.toList()
	sharedRelaySessions.clear()
	for (session in sessions) {
		clearReconnect(session)
		session.idleJob?.cancel()
		session.idleJob = null
		for (attempt in session.pending.toList()) closeQueuedAttempt(session, attempt)
		for (attempt in session.inflight.toList()) {
			session.inflight.remove(attempt)
			clearQueuedDeadline(attempt)
			if (!attempt.deferred.isCompleted) attempt.deferred.complete(false)
		}
		session.connection?.let { runCatching { it.close() } }
		session.connection = null
	}
}

private fun clearIdleDrop(session: SharedRelaySession) {
	session.idleJob?.cancel()
	session.idleJob = null
}

private fun clearReconnect(session: SharedRelaySession) {
	session.reconnectJob?.cancel()
	session.reconnectJob = null
	session.connectJob?.cancel()
	session.connectJob = null
}

/** 清除待发请求的等待上限定时器。 */
private fun clearQueuedDeadline(attempt: PublishAttempt) {
	attempt.deadlineJob?.cancel()
	attempt.deadlineJob = null
}

/**
 * 结算一个仍在队列里的 publish：出队 + 以 connect-stage 错误 reject；若会话再无工作则一并回收。
 *
 * 刻意不取 [sessionMutex]：重连循环会在持锁状态下等待宿主 connect（最长 [NOSTR_CONNECT_TIMEOUT_MS]），
 * 结算若排队等锁，就会与「卡住的连接」互相拖住（fount-p2p#37）。
 * @param session 会话
 * @param attempt 待发请求
 * @return 是否确实出队并结算
 */
private fun closeQueuedAttempt(session: SharedRelaySession, attempt: PublishAttempt): Boolean {
	if (!session.pending.remove(attempt)) return false
	clearQueuedDeadline(attempt)
	if (!attempt.deferred.isCompleted)
		attempt.deferred.completeExceptionally(IllegalStateException("nostr: connect timeout for ${session.url}"))
	if (!session.hasPendingWork()) {
		sharedRelaySessions.remove(session.url)
		clearReconnect(session)
		session.connection?.let { runCatching { it.close() } }
		session.connection = null
	}
	return true
}

/**
 * 为队列中的 publish 挂上等待上限：从入队起算，超时即出队并结算。
 * 只覆盖「尚未拿到可用 socket」的阶段；已 flush 到 open socket 的请求由 [NOSTR_PUBLISH_OK_TIMEOUT_MS] 负责。
 * 定时器跨断线重发保留（请求在 pending ↔ inflight 间移动时不重置），故僵尸请求的总等待有界。
 */
private fun attachQueuedDeadline(session: SharedRelaySession, attempt: PublishAttempt) {
	clearQueuedDeadline(attempt)
	val deadline = queuedPublishDeadlineMs
	if (deadline <= 0) return
	attempt.deadlineJob = sessionScope.launch {
		delay(deadline)
		attempt.deadlineJob = null
		// 已 flush 到 open socket 时出队失败，改由本次发送的 OK 超时结算。
		closeQueuedAttempt(session, attempt)
	}
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

private fun handleMessage(session: SharedRelaySession, ws: WebSocketConnection, text: String) {
	val parsed = try {
		Json.parse(text) as? List<*>
	}
	catch (_: Exception) {
		return
	}
	if (parsed?.getOrNull(0) == "OK") {
		val key = ws to (parsed.getOrNull(1)?.toString() ?: "")
		for (waiter in session.publishAcks[key] ?: emptyList()) waiter.complete(parsed.getOrNull(2) == true)
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
	ws.onMessage = { handleMessage(session, ws, it) }
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
		session.connectJob = sessionScope.launch {
			try {
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
						// 连接超时由 connectRelay 保证；本协程的取消也必须能归还 sessionMutex，
						// 否则被清理的重连会一直占着锁（宿主 connect 不响应取消时尤其明显）。
						val ws = connectRelay(session.url, NOSTR_CONNECT_TIMEOUT_MS, null, session.connectTarget)
						session.connecting = false
						if (sharedRelaySessions[session.url] !== session || !session.hasPendingWork()) {
							sharedRelaySessions.remove(session.url)
							runCatching { ws.terminate() }
							return@withLock
						}
						attachSocket(session, ws)
					}
					catch (error: Exception) {
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
			finally {
				val self = coroutineContext[Job]
				if (self != null && session.connectJob === self) session.connectJob = null
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

/**
 * 取（必要时新建）共享 relay 会话，并在同一次持锁内登记 [registerWork]（入队发布或挂上订阅）。
 *
 * 登记必须与「登记会话」同锁完成：重连协程也持这把锁，若它先看到会话没有工作，就会把刚建好的
 * 会话当成无工作直接删掉，请求只能等到入队上限才失败（表现为发布/订阅随机超时）。
 * @param url 中继 URL
 * @param connectTarget 钉 IP 用的连接目标
 * @param registerWork 持锁登记的会话工作
 * @return 请求归属的会话
 */
private suspend fun withSharedRelay(
	url: String,
	connectTarget: RelayConnectTarget?,
	registerWork: (SharedRelaySession) -> Unit,
): SharedRelaySession =
	sessionMutex.withLock {
		val session = sharedRelaySessions[url] ?: SharedRelaySession(url).also {
			it.connectTarget = connectTarget
			sharedRelaySessions[url] = it
		}
		registerWork(session)
		// 无现成 socket 时触发连接；有则交给调用方 flush。
		if (session.connection == null) scheduleReconnect(session)
		session
	}

private fun flushPending(session: SharedRelaySession) {
	val ws = session.connection ?: return
	val pending = session.pending.toList()
	session.pending.clear()
	for (attempt in pending) {
		clearQueuedDeadline(attempt)
		session.inflight.add(attempt)
		sessionScope.launch {
			val outcome = runCatching { publishEventOnRelay(session, ws, attempt) }
			sessionMutex.withLock {
				if (!session.inflight.remove(attempt)) return@withLock
				if (!attempt.deferred.isCompleted) outcome.fold(
					{ attempt.deferred.complete(it) }, { attempt.deferred.completeExceptionally(it) },
				)
				if (!session.hasPendingWork()) scheduleIdleDrop(session)
			}
		}
	}
}

private suspend fun publishEventOnRelay(session: SharedRelaySession, ws: WebSocketConnection, attempt: PublishAttempt): Boolean {
	if (attempt.signal?.aborted == true) throw IllegalStateException("nostr: aborted")
	return withTimeoutOrNull(NOSTR_PUBLISH_OK_TIMEOUT_MS) {
		val result = CompletableDeferred<Boolean>()
		// 按 (socket, event id) 登记等待者：共享 socket 的单一 onMessage 分发 OK，多个并发发布各等各的回执。
		val key = ws to (attempt.event["id"]?.toString() ?: "")
		session.publishAcks.compute(key) { _, waiters -> (waiters ?: CopyOnWriteArrayList()).also { it.add(result) } }
		val onAbort: () -> Unit = { result.completeExceptionally(IllegalStateException("nostr: aborted")) }
		attempt.signal?.addEventListener(onAbort)
		try {
			ws.send(Json.stringify(listOf("EVENT", attempt.event)) ?: "")
			result.await()
		}
		finally {
			attempt.signal?.removeEventListener(onAbort)
			session.publishAcks.computeIfPresent(key) { _, waiters ->
				waiters.remove(result)
				waiters.takeIf { it.isNotEmpty() }
			}
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
 * 连不上的 relay 由入队等待上限（[NOSTR_QUEUED_PUBLISH_DEADLINE_MS]）结算，不会永久悬挂。
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
	val attempt = PublishAttempt(event, signal, 0, CompletableDeferred())
	val session = withSharedRelay(relayUrl, connectTarget) { it.pending.add(attempt) }
	clearIdleDrop(session)
	// 入队和派发共用互斥锁，防止多个宿主线程同时取走同一批 pending。
	val queued = sessionMutex.withLock {
		if (session.connection?.readyState == WS_OPEN) {
			flushPending(session)
			false
		}
		else {
			attachQueuedDeadline(session, attempt)
			true
		}
	}
	if (!queued) return attempt.deferred.await()
	/** 尚未发出去就被取消：出队并结算；已 flush 到 socket 时出队失败，改由本次发送的 abort 分支结算。 */
	val onQueuedAbort: () -> Unit = {
		// 锁暂时被占用时也保留取消工作，不能把一次性 abort 通知丢掉。
		sessionScope.launch {
			sessionMutex.withLock {
				if (session.pending.remove(attempt)) {
					clearQueuedDeadline(attempt)
					if (!attempt.deferred.isCompleted) attempt.deferred.completeExceptionally(IllegalStateException("nostr: aborted"))
				}
			}
		}
	}
	signal?.addEventListener(onQueuedAbort)
	val deadline = queuedPublishDeadlineMs
	try {
		if (deadline <= 0) return attempt.deferred.await()
		return withTimeout(deadline) { attempt.deferred.await() }
	}
	catch (_: TimeoutCancellationException) {
		// 兜底等待上限：僵尸请求（连不上的 relay + 无限退避重连）必须结算，而不是让调用方永久悬挂。
		// 真正的会话清理由这里补做：cancel 掉 deadlineJob 后它自己不会再跑（fount-p2p#37）。
		closeQueuedAttempt(session, attempt)
		throw IllegalStateException("nostr: connect timeout for $relayUrl")
	}
	finally { signal?.removeEventListener(onQueuedAbort) }
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
			val session = withSharedRelay(relayUrl, target) { it.subs[subscriptionId] = RelaySub(filter, onEvent) }
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
