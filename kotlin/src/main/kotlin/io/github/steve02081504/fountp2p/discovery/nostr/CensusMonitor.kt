package io.github.steve02081504.fountp2p.discovery.nostr

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.base64ToBytes
import io.github.steve02081504.fountp2p.link.CoroutineLinkScheduler
import io.github.steve02081504.fountp2p.link.LinkScheduler
import io.github.steve02081504.fountp2p.link.LinkTimerTask
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.net.URI

/** NIP-66 relay 注册 kind。 */
private const val NIP66_KIND = 30166

/** NIP-66 发现周期。 */
private const val MONITOR_NIP66_REFRESH_MS = 30L * 60_000

/** 单次 NIP-66 REQ 上限。 */
private const val NIP66_REQ_LIMIT = 300

/** 监控 relay 数上限。 */
private const val MAX_MONITOR_RELAYS = 32

/** relay 帧 content 最大长度。 */
private const val MAX_FRAME_BYTES = 16 * 1024

/** 并发验签任务上限。 */
private const val MAX_INFLIGHT_VERIFICATIONS = 8

/** 单次连接超时。 */
private const val CONNECT_TIMEOUT_MS = 10_000L

/** 断线重连指数退避初始延迟与上限。 */
private const val RECONNECT_BASE_MS = 1_000L
private const val RECONNECT_MAX_MS = 30_000L

/** 事件入库后刷新防抖。 */
private const val REFRESH_DEBOUNCE_MS = 300L

/** 无事件时周期刷新默认间隔。 */
private const val DEFAULT_REFRESH_MS = 5_000L

/**
 * 规范化 Nostr relay URL（浏览器端轻量版）：仅 ws/wss，小写 host，去默认端口与尾部斜杠。
 * @param raw 原始 URL
 * @return 规范化字符串，无效返回 null
 */
fun normalizeMonitorRelayUrl(raw: Any?): String? {
	val value = (raw?.toString() ?: "").trim()
	if (value.isEmpty()) return null
	val uri = try {
		URI(value)
	}
	catch (_: Exception) {
		return null
	}
	val scheme = (uri.scheme ?: "").lowercase()
	if (scheme != "wss" && scheme != "ws") return null
	var host = (uri.host ?: "").lowercase()
	if (host.isEmpty()) return null
	val ipv6 = host.contains(":")
	var port = uri.port
	if ((scheme == "wss" && port == 443) || (scheme == "ws" && port == 80)) port = -1
	val path = (uri.path ?: "").replace(Regex("/+$"), "").ifEmpty { "/" }
	val hostPart = if (ipv6) "[$host]" else host
	val portPart = if (port > 0) ":$port" else ""
	val pathPart = if (path == "/") "/" else path
	host = "$scheme://$hostPart$portPart$pathPart"
	return host.replace(Regex("/$"), "")
}

internal class RelaySession(val url: String) {
	var connection: WebSocketConnection? = null
	var subId: String = ""
	val events = LinkedHashMap<String, Pair<Double, Long>>()
	var inflight = 0
	var reconnectDelayMs = RECONNECT_BASE_MS
	var reconnectTask: LinkTimerTask? = null
	var connectTimeoutTask: LinkTimerTask? = null
}

/** `createPopulationMonitor` 选项。 */
class PopulationMonitorOptions(
	val onUpdate: (Map<String, Any?>) -> Unit,
	val relays: List<String>? = null,
	val signal: AbortSignalLike? = null,
	val refreshMs: Long = DEFAULT_REFRESH_MS,
	val discover: Boolean = true,
	val nip66Bootstrap: List<String> = NIP66_BOOTSTRAP_RELAYS,
	val webSocketProvider: WebSocketProvider? = null,
	val scheduler: LinkScheduler? = null,
	val now: () -> Long = { System.currentTimeMillis() },
)

/**
 * 浏览器端人口统计监控器（无 Node 依赖；WebSocket + Ed25519 验签）。
 *
 * Kotlin 侧 WebSocket 经注入的 [WebSocketProvider] 提供；定时经 [LinkScheduler]（测试可注入假调度器）。
 */
class PopulationMonitor(private val options: PopulationMonitorOptions) {
	private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
	private val scheduler: LinkScheduler = options.scheduler ?: CoroutineLinkScheduler(scope)
	private val now = options.now

	private val relayUrls = ArrayList<String>()
	private var stopped = false
	private val sessions = LinkedHashMap<String, RelaySession>()
	private var refreshTask: LinkTimerTask? = null
	private var refreshDebounce: LinkTimerTask? = null
	private var discoveryTask: LinkTimerTask? = null

	init {
		for (raw in if (!options.relays.isNullOrEmpty()) options.relays else DEFAULT_RELAY_URLS) {
			val url = normalizeMonitorRelayUrl(raw) ?: continue
			if (!relayUrls.contains(url)) relayUrls.add(url)
		}
		if (relayUrls.isEmpty()) throw IllegalArgumentException("p2p: population monitor requires at least one relay url")
		for (url in relayUrls) {
			val session = RelaySession(url)
			sessions[url] = session
			connectSession(session)
		}
		if (options.discover) startDiscovery()
		refresh()
		if (options.refreshMs > 0)
			refreshTask = scheduler.schedule(options.refreshMs, options.refreshMs) { refresh() }
		val signal = options.signal
		if (signal != null) {
			if (signal.aborted) stop()
			else signal.addEventListener { stop() }
		}
	}

	private fun createSession(url: String): RelaySession = RelaySession(url)

	private fun connectSession(session: RelaySession) {
		if (stopped || session.connection != null) return
		val provider = options.webSocketProvider ?: return
		scope.launch {
			if (stopped || session.connection != null) return@launch
			val connection = try {
				provider.connect(session.url, null)
			}
			catch (_: Exception) {
				scheduleReconnect(session)
				return@launch
			}
			session.connection = connection
			session.connectTimeoutTask = scheduler.schedule(CONNECT_TIMEOUT_MS, null) {
				if (session.connection === connection) runCatching { connection.close() }
			}
			connection.onMessage = { data -> handleRelayMessage(session, data) }
			connection.onClose = {
				session.connectTimeoutTask?.cancel()
				if (session.connection === connection) {
					session.connection = null
					scheduleReconnect(session)
				}
			}
			connection.onError = {
				// close follows error
			}
			session.reconnectDelayMs = RECONNECT_BASE_MS
			session.subId = "census-" + java.lang.Long.toString(System.nanoTime(), 36)
			runCatching {
				connection.send(
					Json.stringify(
						listOf(
							"REQ",
							session.subId,
							linkedMapOf<String, Any?>(
								"kinds" to listOf(NOSTR_CENSUS_KIND.toDouble()),
								"#t" to listOf(CENSUS_TAG_FOUNT),
								"#x" to listOf(CENSUS_TAG_X),
							),
						),
					) ?: "",
				)
			}
		}
	}

	private fun scheduleReconnect(session: RelaySession) {
		if (stopped || session.reconnectTask != null) return
		session.reconnectTask = scheduler.schedule(session.reconnectDelayMs, null) {
			session.reconnectTask = null
			connectSession(session)
		}
		session.reconnectDelayMs = minOf(session.reconnectDelayMs * 2, RECONNECT_MAX_MS)
	}

	/**
	 * 处理单条 relay 消息：验签 census 帧并入库。
	 * @param session 会话
	 * @param data 消息数据
	 */
	internal fun handleRelayMessage(session: RelaySession, data: String) {
		if (session.inflight >= MAX_INFLIGHT_VERIFICATIONS) return
		if (data.length > MAX_FRAME_BYTES) return
		val parsed = try {
			Json.parse(data) as? List<*>
		}
		catch (_: Exception) {
			null
		}
		if (parsed?.getOrNull(0) != "EVENT" || parsed.getOrNull(1) != session.subId) return
		val event = parsed.getOrNull(2) as? Map<*, *> ?: return
		if (event["kind"] != NOSTR_CENSUS_KIND.toDouble()) return
		val content = event["content"] as? String ?: return
		if (content.length > MAX_FRAME_BYTES) return
		session.inflight++
		try {
			val verified = verifyCensusBytes(base64ToBytes(content))
			if (verified == null) return
			val existing = session.events[verified.nodeHash]
			if (existing != null && verified.ts < existing.second) return
			session.events[verified.nodeHash] = verified.p to verified.ts.toLong()
			scheduleRefresh()
		}
		catch (_: Exception) {
			// ignore malformed
		}
		finally {
			session.inflight--
		}
	}

	/**
	 * 会话快照（逐出过期事件后 HT 估计）。
	 * @param session 会话
	 * @return 快照
	 */
	internal fun sessionSnapshot(session: RelaySession): Map<String, Any?> {
		val nowMs = now()
		val events = ArrayList<Any?>()
		val iterator = session.events.entries.iterator()
		while (iterator.hasNext()) {
			val (hash, value) = iterator.next()
			if (nowMs - value.second > CENSUS_TTL_MS) iterator.remove()
			else events.add(mapOf("p" to value.first, "at" to value.second.toDouble()))
		}
		val estimate = estimatePopulation(events)
		return linkedMapOf(
			"estimate" to estimate.estimate,
			"sampleSize" to estimate.sampleSize.toDouble(),
			"eventsInWindow" to events.size.toDouble(),
		)
	}

	/** 取人口估计最大的 relay 作为显示源，回调 onUpdate。 */
	internal fun refresh() {
		var bestUrl: String? = null
		var bestSnapshot: Map<String, Any?>? = null
		for (session in sessions.values) {
			val snapshot = sessionSnapshot(session)
			if (bestSnapshot == null || (snapshot["estimate"] as Double) > (bestSnapshot["estimate"] as Double)) {
				bestUrl = session.url
				bestSnapshot = snapshot
			}
		}
		val chosenUrl = bestUrl ?: relayUrls.first()
		val chosenSnapshot = bestSnapshot ?: linkedMapOf("estimate" to 0.0, "sampleSize" to 0.0, "eventsInWindow" to 0.0)
		options.onUpdate(chosenSnapshot + mapOf("relayUrl" to chosenUrl, "relays" to sessions.size.toDouble()))
	}

	private fun scheduleRefresh() {
		if (refreshDebounce != null || stopped) return
		refreshDebounce = scheduler.schedule(REFRESH_DEBOUNCE_MS, null) {
			refreshDebounce = null
			refresh()
		}
	}

	private suspend fun collectNip66Candidates(relayUrl: String, onCandidate: (String) -> Unit) {
		val provider = options.webSocketProvider ?: return
		val connection = try {
			provider.connect(relayUrl, null)
		}
		catch (_: Exception) {
			return
		}
		val done = CompletableDeferred<Unit>()
		var timeoutTask: LinkTimerTask? = null
		connection.onMessage = { data ->
			val parsed = try {
				Json.parse(data) as? List<*>
			}
			catch (_: Exception) {
				null
			}
			if (parsed != null) {
				if (parsed.getOrNull(0) == "EOSE") {
					if (!done.isCompleted) done.complete(Unit)
				}
				else if (parsed.getOrNull(0) == "EVENT" && (parsed.getOrNull(2) as? Map<*, *>)?.get("kind") == NIP66_KIND.toDouble()) {
					val tags = (parsed.getOrNull(2) as? Map<*, *>)?.get("tags") as? List<*>
					val d = tags?.firstOrNull { (it as? List<*>)?.getOrNull(0) == "d" }?.let { (it as List<*>).getOrNull(1) }
					val url = normalizeMonitorRelayUrl(d)
					if (url != null) onCandidate(url)
				}
			}
		}
		connection.onClose = { if (!done.isCompleted) done.complete(Unit) }
		connection.onError = { if (!done.isCompleted) done.complete(Unit) }
		timeoutTask = scheduler.schedule(CONNECT_TIMEOUT_MS, null) { if (!done.isCompleted) done.complete(Unit) }
		runCatching {
			connection.send(
				Json.stringify(
					listOf(
						"REQ",
						"nip66-" + java.lang.Long.toString(System.nanoTime(), 36),
						linkedMapOf<String, Any?>("kinds" to listOf(NIP66_KIND.toDouble(), 10166.0), "limit" to NIP66_REQ_LIMIT.toDouble()),
					),
				) ?: "",
			)
		}
		done.await()
		timeoutTask.cancel()
		runCatching { connection.close() }
	}

	private suspend fun runDiscovery() {
		val candidates = ArrayList<String>()
		val sources = ArrayList<String>()
		sources.addAll(options.nip66Bootstrap)
		sources.addAll(sessions.keys)
		for (url in sources.distinct()) {
			try {
				collectNip66Candidates(url) { candidate -> if (!candidates.contains(candidate)) candidates.add(candidate) }
			}
			catch (_: Exception) {
				// skip bad source
			}
		}
		for (url in candidates) {
			if (stopped || sessions.size >= MAX_MONITOR_RELAYS) break
			if (sessions.containsKey(url)) continue
			val session = createSession(url)
			sessions[url] = session
			connectSession(session)
		}
	}

	private fun startDiscovery() {
		scope.launch { runCatching { runDiscovery() } }
		discoveryTask = scheduler.schedule(MONITOR_NIP66_REFRESH_MS, MONITOR_NIP66_REFRESH_MS) {
			scope.launch { runCatching { runDiscovery() } }
		}
	}

	/** 停止监控：关闭全部连接与定时器。 */
	fun stop() {
		if (stopped) return
		stopped = true
		refreshTask?.cancel()
		refreshTask = null
		refreshDebounce?.cancel()
		refreshDebounce = null
		discoveryTask?.cancel()
		discoveryTask = null
		for (session in sessions.values) {
			session.reconnectTask?.cancel()
			session.reconnectTask = null
			session.connectTimeoutTask?.cancel()
			session.connectTimeoutTask = null
			runCatching { session.connection?.close() }
			session.connection = null
		}
		sessions.clear()
	}
}

/**
 * 创建人口统计监控器：立即连接并监听，返回 `{ stop }` 控制句柄。
 * @param options 选项
 * @return 监控句柄
 */
fun createPopulationMonitor(options: PopulationMonitorOptions): PopulationMonitor = PopulationMonitor(options)

/**
 * @param options 选项
 * @return `{ stop }` 句柄映射（JS 形状）
 */
fun createPopulationMonitorHandle(options: PopulationMonitorOptions): Map<String, Any?> {
	val monitor = createPopulationMonitor(options)
	return linkedMapOf("stop" to { monitor.stop() })
}

