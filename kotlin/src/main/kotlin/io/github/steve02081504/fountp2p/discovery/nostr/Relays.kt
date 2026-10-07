package io.github.steve02081504.fountp2p.discovery.nostr

import io.github.steve02081504.fountp2p.node.getNodeTransportSettings
import io.github.steve02081504.fountp2p.node.getSignalingRuntimeConfig
import io.github.steve02081504.fountp2p.node.readNostrRelaysJsonSync
import io.github.steve02081504.fountp2p.node.writeNostrRelaysJsonSync
import io.github.steve02081504.fountp2p.node.nodeDebug
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.URI
import java.net.URL
import java.util.Timer
import java.util.TimerTask

/** 持久化写盘节流延迟。 */
private const val FLUSH_DELAY_MS = 2_000L

/** probe 单次连接超时。 */
private const val PROBE_TIMEOUT_MS = 10_000L

/** NIP-66 发现 REQ limit。 */
private const val NIP66_REQ_LIMIT = 500

/** 每轮 NIP-66 候选 probe 上限。 */
private const val MAX_NIP66_PROBES_PER_ROUND = 48

/** NIP-66 候选 probe 并发批大小。 */
private const val NIP66_PROBE_BATCH_SIZE = 8

/** relay 来源。 */
typealias RelaySource = String

/** relay 池条目（可变，便于合并统计）。 */
class RelayPoolEntry(
	var url: String,
	var rttMs: Double?,
	var successCount: Int,
	var failureCount: Int,
	var lastSuccess: Long,
	var lastFailure: Long,
	var lastProbe: Long,
	var firstSeen: Long,
	var lastSeen: Long,
	var source: RelaySource,
	var nips: List<String>,
	var clearnet: Boolean,
	var monitorCount: Int,
) {
	/** @return 可序列化的 JSON 对象 */
	fun toJson(): Map<String, Any?> = linkedMapOf(
		"url" to url,
		"rttMs" to rttMs,
		"successCount" to successCount.toDouble(),
		"failureCount" to failureCount.toDouble(),
		"lastSuccess" to lastSuccess.toDouble(),
		"lastFailure" to lastFailure.toDouble(),
		"lastProbe" to lastProbe.toDouble(),
		"firstSeen" to firstSeen.toDouble(),
		"lastSeen" to lastSeen.toDouble(),
		"source" to source,
		"nips" to nips,
		"clearnet" to clearnet,
		"monitorCount" to monitorCount.toDouble(),
	)
}

/** peer pool 条目（url + 对端上报 rtt）。 */
data class PeerPoolItem(val url: String, val rttMs: Double?)

/** 对端路由。 */
data class PeerRoute(
	val listenRelays: List<String> = emptyList(),
	val peerPool: List<PeerPoolItem> = emptyList(),
	val lastGoodNostrRelays: List<String> = emptyList(),
	val lastSeen: Long = 0L,
) {
	/** @return 深拷贝（等价 JS 展开） */
	fun copyDeep(): PeerRoute = PeerRoute(listenRelays.toList(), peerPool.toList(), lastGoodNostrRelays.toList(), lastSeen)
}

/** relay 持久化 IO 抽象（默认走 nodeDir/nostr/relays.json）。 */
interface RelayStorageIO {
	/** @return 已读取的 relay 数据 */
	fun read(): Any?

	/**
	 * @param data relay 数据
	 */
	fun write(data: Any?)
}

private var storageIO: RelayStorageIO = object : RelayStorageIO {
	override fun read(): Any? = readNostrRelaysJsonSync()
	override fun write(data: Any?) = writeNostrRelaysJsonSync(data)
}

/** DNS 解析抽象（Android/JVM 共用；测试可注入）。 */
interface RelayDnsResolver {
	/**
	 * @param hostname 主机名
	 * @return 解析到的地址列表
	 */
	suspend fun lookup(hostname: String): List<String>
}

/** 默认 JVM DNS 解析实现。 */
object DefaultRelayDnsResolver : RelayDnsResolver {
	override suspend fun lookup(hostname: String): List<String> = try {
		InetAddress.getAllByName(hostname).map { it.hostAddress ?: "" }.filter { it.isNotEmpty() }
	}
	catch (_: Exception) {
		emptyList()
	}
}

private var dnsResolver: RelayDnsResolver = DefaultRelayDnsResolver

/** @param resolver DNS 解析实现 */
fun setRelayDnsResolver(resolver: RelayDnsResolver) {
	dnsResolver = resolver
}

private var poolEntries = LinkedHashMap<String, RelayPoolEntry>()
private var peerRoutes = LinkedHashMap<String, PeerRoute>()
private val providerTrustedRelayUrls = LinkedHashMap<String, Int>()
private var dirty = false
private var flushTimer: Timer? = null

private var bootstrapRelaysOverride: List<String> = emptyList()
private var discoveryEnabled = true

/**
 * 规范化 Nostr relay URL（唯一入站入口）。
 *
 * 仅允许 `wss://`；`ws://` 仅限回环/私有地址。hostname 小写，去除默认端口与尾部斜杠。
 * @param raw 原始 URL
 * @return 规范化字符串，无效返回 null
 */
fun normalizeNostrRelayUrl(raw: Any?): String? {
	val value = (raw?.toString() ?: "").trim()
	if (value.isEmpty()) return null
	val url = try {
		URI(value)
	}
	catch (_: Exception) {
		return null
	}
	val scheme = (url.scheme ?: "").lowercase()
	if (scheme == "ws") {
		val host = (url.host ?: "").lowercase().replace(Regex("^\\[|]$"), "")
		val isLoopback = host == "localhost" || host == "::1" || host.startsWith("127.")
		if (!isLoopback) return null
	}
	else if (scheme != "wss") return null

	var hostname = (url.host ?: "").lowercase()
	if (hostname.isEmpty()) return null
	var port = url.port
	if ((scheme == "wss" && port == 443) || (scheme == "ws" && port == 80)) port = -1
	val path = (url.path ?: "").replace(Regex("/+$"), "").ifEmpty { "/" }
	val hostPart = if (hostname.contains(":")) "[$hostname]" else hostname
	val portPart = if (port > 0) ":$port" else ""
	val pathPart = if (path == "/") "/" else path
	val built = "$scheme://$hostPart$portPart$pathPart"
	return built.replace(Regex("/$"), "")
}

/**
 * 判定规范化 relay URL 是否为公网可达。
 * @param normalizedUrl 已 normalize 的 relay URL
 * @return 公网为 true
 */
private fun isPublicRelayUrl(normalizedUrl: String): Boolean {
	val hostnameRaw = try {
		(URI(normalizedUrl).host ?: "")
	}
	catch (_: Exception) {
		return false
	}
	val hostname = hostnameRaw.lowercase().replace(Regex("^\\[|]$"), "")
	if (hostname.isEmpty()) return false
	if (hostname.endsWith(".")) return false
	if (hostname in listOf("localhost", "::1", "::", "0.0.0.0")) return false
	if (Regex("\\.(local|internal|lan|home|corp)$").containsMatchIn(hostname)) return false
	if (Regex("^(127\\.|10\\.|192\\.168\\.|169\\.254\\.|172\\.(1[6-9]|2\\d|3[01])\\.|100\\.(6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.)").containsMatchIn(hostname)) return false
	if (Regex("^(192\\.0\\.0\\.|192\\.0\\.2\\.|198\\.(18|19)\\.|203\\.0\\.113\\.|198\\.51\\.100\\.|22[4-9]\\.|23[0-9]\\.|24[0-9]\\.|25[0-5]\\.)").containsMatchIn(hostname)) return false
	if (Regex("^fe[89ab][\\da-f]:", RegexOption.IGNORE_CASE).containsMatchIn(hostname) ||
		Regex("^f[cd][\\da-f]:", RegexOption.IGNORE_CASE).containsMatchIn(hostname) ||
		Regex("^fec0:", RegexOption.IGNORE_CASE).containsMatchIn(hostname)
	) return false
	if (Regex("^2001:db8:", RegexOption.IGNORE_CASE).containsMatchIn(hostname) ||
		Regex("^ff[\\da-f]{2}:", RegexOption.IGNORE_CASE).containsMatchIn(hostname)
	) return false
	if (Regex("^::ffff:[\\d.a-f]+$", RegexOption.IGNORE_CASE).matches(hostname)) {
		val ipv4 = hostname.replace(Regex("^::ffff:", RegexOption.IGNORE_CASE), "")
		if (Regex("^(?:\\d+\\.){3}\\d+$").matches(ipv4)) return isPublicRelayUrl("ws://$ipv4")
		return false
	}
	if (Regex("^:{2}(?:\\d+\\.){3}\\d+$", RegexOption.IGNORE_CASE).matches(hostname)) return false
	return true
}

private fun locallyAllowedRelayUrls(): List<String> {
	val configRelay = (getSignalingRuntimeConfig()["channels"] as? Map<*, *>)?.get("nostr")?.let { (it as? Map<*, *>)?.get("relay") }
	if (configRelay is List<*> && configRelay.isNotEmpty())
		return dedupeRelayUrls(configRelay.map { normalizeNostrRelayUrl(it) }.filterNotNull())
	return try {
		val relayUrls = getNodeTransportSettings()["relayUrls"] as? List<*> ?: emptyList<Any?>()
		dedupeRelayUrls(relayUrls.map { normalizeNostrRelayUrl(it) }.filterNotNull())
	}
	catch (_: Exception) {
		emptyList()
	}
}

/** @return 本机显式配置的 relay 集（已 normalize） */
private fun currentTrustedRelayUrls(): Set<String> {
	val out = LinkedHashSet<String>()
	out.addAll(locallyAllowedRelayUrls())
	out.addAll(providerTrustedRelayUrls.keys)
	out.addAll(if (bootstrapRelaysOverride.isNotEmpty()) bootstrapRelaysOverride else NIP66_BOOTSTRAP_RELAYS)
	out.addAll(getPinnedRelays())
	return out
}

private fun isIpLiteral(hostname: String): Boolean =
	Regex("^(?:\\d{1,3}\\.){3}\\d{1,3}$").matches(hostname) || hostname.contains(":")

/**
 * 解析 relay host 的全部地址。
 * @param relayUrl relay URL
 * @return 解析结果；解析失败为 null
 */
suspend fun lookupRelayHost(relayUrl: String): RelayConnectTarget? {
	val hostname = try {
		(URI(relayUrl).host ?: "").lowercase().replace(Regex("^\\[|]$"), "")
	}
	catch (_: Exception) {
		return null
	}
	if (hostname.isEmpty() || hostname.endsWith(".")) return null
	if (isIpLiteral(hostname)) return RelayConnectTarget(hostname, listOf(hostname))
	val records = try {
		dnsResolver.lookup(hostname)
	}
	catch (_: Exception) {
		emptyList()
	}
	if (records.isEmpty()) return null
	return RelayConnectTarget(hostname, records)
}

private suspend fun relayUrlResolvesPublic(relayUrl: String): Boolean {
	val resolved = lookupRelayHost(relayUrl) ?: return false
	return resolved.addresses.all { isPublicRelayUrl("ws://$it") }
}

/**
 * 解析 relay 连接目标：受信集解析任意地址；其余须为公网 hostname 且全部 DNS 记录解析为公网地址。
 * @param relayUrl 规范化 relay URL
 * @return 连接目标；不允许为 null
 */
suspend fun resolveRelayConnectTarget(relayUrl: String): RelayConnectTarget? {
	if (relayUrl.isEmpty()) return null
	val trusted = currentTrustedRelayUrls().contains(relayUrl)
	if (!trusted && !isPublicRelayUrl(relayUrl)) return null
	val resolved = lookupRelayHost(relayUrl) ?: return null
	if (!trusted && !resolved.addresses.all { isPublicRelayUrl("ws://$it") }) return null
	return resolved
}

/**
 * 注册提供方显式配置的 relay（受信），对规范化 URL 维护引用计数。
 * @param urls relay URL 列表
 * @return 释放句柄
 */
fun registerProviderTrustedRelayUrls(urls: List<String>?): () -> Unit {
	val normalized = ArrayList<String>()
	for (url in dedupeRelayUrls(urls)) {
		val n = normalizeNostrRelayUrl(url) ?: continue
		if (!normalized.contains(n)) normalized.add(n)
	}
	for (url in normalized) providerTrustedRelayUrls[url] = (providerTrustedRelayUrls[url] ?: 0) + 1
	return {
		for (url in normalized) {
			val count = (providerTrustedRelayUrls[url] ?: 0) - 1
			if (count <= 0) providerTrustedRelayUrls.remove(url)
			else providerTrustedRelayUrls[url] = count
		}
	}
}

/**
 * 判定该 relay 是否允许作为连接目的地。
 * @param relayUrl 规范化 relay URL
 * @return 允许连接为 true
 */
suspend fun isRelayDestinationAllowed(relayUrl: String?): Boolean {
	if (relayUrl.isNullOrEmpty()) return false
	if (currentTrustedRelayUrls().contains(relayUrl)) return true
	if (!isPublicRelayUrl(relayUrl)) return false
	return relayUrlResolvesPublic(relayUrl)
}

/**
 * 最近一次尝试是否失败。时间戳与 lastSuccess 打平按失败算（同一毫秒内的并发尝试里，成功者会记下更晚的时间戳）。
 * @param lastFailure 最近一次失败时间戳
 * @param lastSuccess 最近一次成功时间戳
 * @return 最近一次尝试失败为 true
 */
private fun latestAttemptFailed(lastFailure: Long, lastSuccess: Long): Boolean = lastFailure >= lastSuccess

/**
 * 计算 relay 健康分（越低越优）。
 * 最近一次尝试失败（或从未成功过）时 RTT 与失败率都取最差值，分数必定高于任何活着的 relay。
 * @param entry 条目
 * @return 健康分
 */
fun computeRelayHealth(entry: RelayPoolEntry): Double {
	val failed = entry.failureCount > 0 && (entry.successCount == 0 || latestAttemptFailed(entry.lastFailure, entry.lastSuccess))
	val total = entry.successCount + entry.failureCount
	val failureRate = if (failed) 1.0 else if (total > 0) entry.failureCount.toDouble() / total else 0.0
	// 失败的 relay 最后一次测量已被作废：没有可信 RTT 可依，按上限算。
	val measuredRtt = if (failed) MAX_RTT_MS.toDouble() else entry.rttMs
	val rtt = maxOf(1.0, minOf(MAX_RTT_MS.toDouble(),
		if (measuredRtt == null || measuredRtt.isNaN() || measuredRtt.isInfinite() || measuredRtt <= 0) DEFAULT_RTT_MS.toDouble() else measuredRtt))
	var score = rtt * (1 + failureRate * FAILURE_WEIGHT)
	if (System.currentTimeMillis() - entry.lastProbe > PROBE_STALE_MS) score *= STALE_PENALTY
	return score
}

private fun isPinned(entry: RelayPoolEntry): Boolean = entry.source == "public" || entry.source == "manual"

private val SOURCE_PRIORITY = mapOf("manual" to 3, "public" to 2, "nip66" to 1, "peer" to 0)

private fun sortByHealth(entries: List<RelayPoolEntry>): List<RelayPoolEntry> =
	entries.sortedBy { computeRelayHealth(it) }

private fun dedupeByUrl(entries: List<RelayPoolEntry>): List<RelayPoolEntry> {
	val seen = HashSet<String>()
	val out = ArrayList<RelayPoolEntry>()
	for (entry in entries) {
		if (seen.contains(entry.url)) continue
		seen.add(entry.url)
		out.add(entry)
	}
	return out
}

private fun markDirty() {
	dirty = true
	if (flushTimer != null) return
	val timer = Timer(true)
	flushTimer = timer
	timer.schedule(object : TimerTask() {
		override fun run() {
			flushTimer = null
			if (dirty) flushRelayState()
		}
	}, FLUSH_DELAY_MS)
}

private fun flushRelayState() {
	if (!dirty) return
	dirty = false
	try {
		val peerRoutesJson = LinkedHashMap<String, Any?>()
		for ((hash, route) in peerRoutes) {
			peerRoutesJson[hash] = linkedMapOf<String, Any?>(
				"listenRelays" to route.listenRelays,
				"peerPool" to route.peerPool.map { linkedMapOf<String, Any?>("url" to it.url, "rttMs" to it.rttMs) },
				"lastGoodNostrRelays" to route.lastGoodNostrRelays,
				"lastSeen" to route.lastSeen.toDouble(),
			)
		}
		storageIO.write(
			linkedMapOf<String, Any?>(
				"updatedAt" to System.currentTimeMillis().toDouble(),
				"nostrRelays" to sortByHealth(poolEntries.values.toList()).map { it.toJson() },
				"peerRoutes" to peerRoutesJson,
			),
		)
	}
	catch (_: Exception) {
		// ignore persist failure
	}
}

/**
 * 从磁盘加载池与 peerRoutes；文件缺失/畸形返回空并播种公共默认。
 * @return 池条目（健康分升序）
 */
fun loadRelayPool(): List<RelayPoolEntry> {
	val data = try {
		storageIO.read()
	}
	catch (_: Exception) {
		null
	}
	val parsed = data as? Map<*, *>
	poolEntries = LinkedHashMap()
	peerRoutes = LinkedHashMap()
	val rawRelays = parsed?.get("nostrRelays")
	if (rawRelays is List<*>) {
		for (raw in rawRelays) {
			val obj = raw as? Map<*, *> ?: continue
			val url = normalizeNostrRelayUrl(obj["url"]) ?: continue
			val entry = toRelayEntry(obj, url)
			poolEntries[url] = entry
		}
	}
	val rawPeerRoutes = parsed?.get("peerRoutes")
	if (rawPeerRoutes is Map<*, *>) {
		for ((hash, raw) in rawPeerRoutes) {
			if (hash !is String) continue
			val route = normalizePeerRoute(raw) ?: continue
			peerRoutes[hash] = route
		}
	}
	seedPublicDefaults()
	return sortByHealth(poolEntries.values.toList())
}

private fun toRelayEntry(raw: Map<*, *>?, url: String): RelayPoolEntry {
	val rtt = (raw?.get("rttMs") as? Number)?.toDouble() ?: Double.NaN
	val source = raw?.get("source")?.toString() ?: ""
	return RelayPoolEntry(
		url = url,
		rttMs = if (rtt.isNaN() || rtt.isInfinite()) null else Math.round(rtt).toDouble(),
		successCount = maxOf(0, ((raw?.get("successCount") as? Number)?.toDouble() ?: 0.0).toInt()),
		failureCount = maxOf(0, ((raw?.get("failureCount") as? Number)?.toDouble() ?: 0.0).toInt()),
		lastSuccess = (raw?.get("lastSuccess") as? Number)?.toLong() ?: 0L,
		lastFailure = (raw?.get("lastFailure") as? Number)?.toLong() ?: 0L,
		lastProbe = (raw?.get("lastProbe") as? Number)?.toLong() ?: 0L,
		firstSeen = (raw?.get("firstSeen") as? Number)?.toLong() ?: System.currentTimeMillis(),
		lastSeen = (raw?.get("lastSeen") as? Number)?.toLong() ?: System.currentTimeMillis(),
		source = if (SOURCE_PRIORITY.containsKey(source)) source else "nip66",
		nips = (raw?.get("nips") as? List<*>)?.mapNotNull { it?.toString()?.takeIf { s -> s.isNotEmpty() } } ?: emptyList(),
		clearnet = raw?.get("clearnet") == true,
		monitorCount = maxOf(0, ((raw?.get("monitorCount") as? Number)?.toDouble() ?: 0.0).toInt()),
	)
}

private fun normalizePeerRouteFields(raw: Any?): PeerRoute? {
	val obj = raw as? Map<*, *> ?: return null
	var listenRelays: List<String>? = null
	var peerPool: List<PeerPoolItem>? = null
	var lastGood: List<String>? = null
	var lastSeen: Long? = null
	val rawListen = obj["listenRelays"]
	if (rawListen is List<*>)
		listenRelays = dedupeRelayUrls(rawListen.map { normalizeNostrRelayUrl(it) }.filterNotNull())
	val rawPool = obj["peerPool"]
	if (rawPool is List<*>)
		peerPool = dedupePeerPool(rawPool.mapNotNull { item ->
			val map = item as? Map<*, *> ?: return@mapNotNull null
			val url = normalizeNostrRelayUrl(map["url"]) ?: return@mapNotNull null
			val rtt = (map["rttMs"] as? Number)?.toDouble()
			PeerPoolItem(url, if (rtt != null && !rtt.isNaN() && !rtt.isInfinite()) Math.round(rtt).toDouble() else null)
		})
	val rawLastGood = obj["lastGoodNostrRelays"]
	if (rawLastGood is List<*>)
		lastGood = dedupeRelayUrls(rawLastGood.map { normalizeNostrRelayUrl(it) }.filterNotNull()).take(LAST_GOOD_RELAYS_MAX)
	if (obj.containsKey("lastSeen")) lastSeen = (obj["lastSeen"] as? Number)?.toLong() ?: System.currentTimeMillis()
	return PeerRoute(
		listenRelays = listenRelays ?: emptyList(),
		peerPool = peerPool ?: emptyList(),
		lastGoodNostrRelays = lastGood ?: emptyList(),
		lastSeen = lastSeen ?: 0L,
	)
}

private fun dedupePeerPool(items: List<PeerPoolItem>): List<PeerPoolItem> {
	val seen = HashSet<String>()
	val out = ArrayList<PeerPoolItem>()
	for (item in items) {
		if (seen.contains(item.url)) continue
		seen.add(item.url)
		out.add(item)
	}
	return out
}

private fun normalizePeerRoute(raw: Any?): PeerRoute? = normalizePeerRouteFields(raw)

private fun seedPublicDefaults() {
	for (url in DEFAULT_RELAY_URLS) {
		val normalized = normalizeNostrRelayUrl(url) ?: continue
		if (poolEntries.containsKey(normalized)) continue
		val now = System.currentTimeMillis()
		poolEntries[normalized] = RelayPoolEntry(
			url = normalized,
			rttMs = null,
			successCount = 0,
			failureCount = 0,
			lastSuccess = 0,
			lastFailure = 0,
			lastProbe = 0,
			firstSeen = now,
			lastSeen = now,
			source = "public",
			nips = emptyList(),
			clearnet = true,
			monitorCount = 0,
		)
	}
	markDirty()
}

/**
 * 按 url 去重 upsert；合并统计字段。
 * @param input 新条目字段（url 必填）
 */
fun upsertRelay(input: Map<String, Any?>) {
	val url = normalizeNostrRelayUrl(input["url"]) ?: return
	val existing = poolEntries[url]
	if (existing == null) {
		val merged = LinkedHashMap<String, Any?>(input)
		merged["url"] = url
		merged["firstSeen"] = System.currentTimeMillis().toDouble()
		poolEntries[url] = toRelayEntry(merged, url)
	}
	else {
		val merged = LinkedHashMap<String, Any?>(input)
		merged["url"] = url
		val incoming = toRelayEntry(merged, url)
		existing.successCount += incoming.successCount
		existing.failureCount += incoming.failureCount
		existing.lastSeen = System.currentTimeMillis()
		if (incoming.lastSuccess != 0L) existing.lastSuccess = incoming.lastSuccess
		if (incoming.lastFailure != 0L) existing.lastFailure = incoming.lastFailure
		if (incoming.lastProbe != 0L) existing.lastProbe = incoming.lastProbe
		if (incoming.rttMs != null) existing.rttMs = incoming.rttMs
		if (incoming.nips.isNotEmpty()) existing.nips = incoming.nips
		existing.clearnet = existing.clearnet || incoming.clearnet
		existing.monitorCount = maxOf(existing.monitorCount, incoming.monitorCount)
		if ((SOURCE_PRIORITY[incoming.source] ?: -1) > (SOURCE_PRIORITY[existing.source] ?: -1))
			existing.source = incoming.source
	}
	enforcePoolCap()
	markDirty()
}

private fun enforcePoolCap() {
	if (poolEntries.size <= POOL_CAP) return
	val sorted = sortByHealth(poolEntries.values.toList())
	var toRemove = poolEntries.size - POOL_CAP
	for (entry in sorted) {
		if (toRemove <= 0) break
		if (isPinned(entry)) continue
		poolEntries.remove(entry.url)
		nodeDebug("invalidRelayUrl", linkedMapOf("url" to entry.url, "reason" to "pool-cap-evicted"))
		toRemove--
	}
}

/**
 * @param url relay URL
 * @param rttMs 成功 RTT
 */
fun recordProbeSuccess(url: String, rttMs: Any?) {
	val normalized = normalizeNostrRelayUrl(url) ?: return
	val entry = ensureEntry(normalized)
	val rtt = (rttMs as? Number)?.toDouble()
	if (rtt != null && !rtt.isNaN() && !rtt.isInfinite())
		entry.rttMs = maxOf(0.0, minOf(MAX_RTT_MS.toDouble(), Math.round(rtt).toDouble()))
	entry.successCount++
	entry.lastSuccess = maxOf(System.currentTimeMillis(), entry.lastProbe + 1)
	entry.lastProbe = entry.lastSuccess
	entry.lastSeen = entry.lastSuccess
	markDirty()
}

/**
 * @param url relay URL
 */
fun recordProbeFailure(url: String) {
	val normalized = normalizeNostrRelayUrl(url) ?: return
	val entry = ensureEntry(normalized)
	entry.failureCount++
	entry.rttMs = null
	entry.lastFailure = maxOf(System.currentTimeMillis(), entry.lastProbe + 1)
	entry.lastProbe = entry.lastFailure
	entry.lastSeen = entry.lastFailure
	markDirty()
}

/**
 * 记录一次发布结果（与探测共用统计）。
 * @param url relay URL
 * @param ok 是否成功
 */
fun recordPublishResult(url: String, ok: Boolean) {
	if (ok) recordProbeSuccess(url, null) else recordProbeFailure(url)
}

private fun ensureEntry(url: String): RelayPoolEntry {
	val existing = poolEntries[url]
	if (existing != null) return existing
	val now = System.currentTimeMillis()
	val entry = RelayPoolEntry(
		url = url,
		rttMs = null,
		successCount = 0,
		failureCount = 0,
		lastSuccess = 0,
		lastFailure = 0,
		lastProbe = 0,
		firstSeen = now,
		lastSeen = now,
		source = "nip66",
		nips = emptyList(),
		clearnet = true,
		monitorCount = 0,
	)
	poolEntries[url] = entry
	return entry
}

/** 移除 lastSeen 超过 24h 且非 public/manual 的项。 */
fun clearStale() {
	val cutoff = System.currentTimeMillis() - PROBE_STALE_MS
	var changed = false
	for ((url, entry) in poolEntries.toList()) {
		if (isPinned(entry)) continue
		if (entry.lastSeen < cutoff) {
			poolEntries.remove(url)
			changed = true
		}
	}
	if (changed) markDirty()
}

/** @return 工作集（保留未探测引导项，排除失败或过期项，优先 pinned） */
fun getWorkingRelays(): List<RelayPoolEntry> {
	val now = System.currentTimeMillis()
	// 合格项：最近一次尝试成功且没过期，或压根还没探测过的引导项。
	val eligible = poolEntries.values.filter { entry ->
		if (entry.successCount == 0) entry.lastFailure == 0L
		else !latestAttemptFailed(entry.lastFailure, entry.lastSuccess) && now - entry.lastSuccess <= PROBE_STALE_MS
	}
	val sorted = sortByHealth(eligible)
	val pinned = sorted.filter { isPinned(it) }
	val rest = sorted.filter { !isPinned(it) }
	return dedupeByUrl(pinned + rest.take(maxOf(0, WORKING_RELAYS_COUNT - pinned.size)))
}

/** @return 监听/发布子集（仅含工作集内 public/manual） */
fun getListenRelays(): List<RelayPoolEntry> {
	val working = getWorkingRelays()
	val pinned = working.filter { isPinned(it) }
	val rest = working.filter { !isPinned(it) }
	return dedupeByUrl(pinned + rest.take(maxOf(0, LISTEN_RELAYS_COUNT - pinned.size)))
}

/** @return url → entry */
fun getPoolByUrl(): Map<String, RelayPoolEntry> = LinkedHashMap(poolEntries)

/**
 * @param k 数量
 * @param excludeUrls 排除的 URL
 * @return 健康分最优前 k 个
 */
@JvmOverloads
fun pickTopRelays(k: Int, excludeUrls: List<String> = emptyList()): List<String> {
	val excluded = excludeUrls.mapNotNull { normalizeNostrRelayUrl(it) }.toSet()
	return sortByHealth(poolEntries.values.toList())
		.filter { !excluded.contains(it.url) }
		.take(k)
		.map { it.url }
}

/** @return 所有 source='public'/'manual' 的 URL */
fun getPinnedRelays(): List<String> = poolEntries.values.filter { isPinned(it) }.map { it.url }

/**
 * @param nodeHash 节点 hash
 * @return route 或 null
 */
fun getPeerRoute(nodeHash: String): PeerRoute? = peerRoutes[nodeHash]?.copyDeep()

/**
 * 更新 peer route（局部 patch），并刷新 lastSeen。
 * @param nodeHash 节点 hash
 * @param patch 补丁
 */
fun setPeerRoute(nodeHash: String?, patch: Map<String, Any?>) {
	if (nodeHash.isNullOrEmpty()) return
	val existing = peerRoutes[nodeHash]
	val normalized = normalizePeerRouteFields(patch) ?: return
	val route = if (existing != null)
		PeerRoute(
			listenRelays = if (patch.containsKey("listenRelays")) normalized.listenRelays else existing.listenRelays,
			peerPool = if (patch.containsKey("peerPool")) normalized.peerPool else existing.peerPool,
			lastGoodNostrRelays = if (patch.containsKey("lastGoodNostrRelays")) normalized.lastGoodNostrRelays else existing.lastGoodNostrRelays,
			lastSeen = System.currentTimeMillis(),
		)
	else
		PeerRoute(
			listenRelays = normalized.listenRelays,
			peerPool = normalized.peerPool,
			lastGoodNostrRelays = normalized.lastGoodNostrRelays,
			lastSeen = System.currentTimeMillis(),
		)
	peerRoutes[nodeHash] = route
	markDirty()
}

/**
 * 解析单个 NIP-66 kind 30166 事件。
 * @param event Nostr 事件
 * @return 解析结果或 null
 */
fun parseNip66Event(event: Any?): Map<String, Any?>? {
	val obj = event as? Map<*, *> ?: return null
	val tags = obj["tags"] as? List<*> ?: emptyList<Any?>()
	fun tagValue(name: String): String? {
		for (tag in tags) {
			val arr = tag as? List<*> ?: continue
			if (arr.getOrNull(0)?.toString() == name) return arr.getOrNull(1)?.toString()
		}
		return null
	}
	val url = normalizeNostrRelayUrl(tagValue("d")) ?: return null
	val n = (tagValue("n") ?: "").lowercase()
	val clearnet = n == "clearnet" || (n.isEmpty() && url.startsWith("wss://"))
	if (!clearnet) return null
	val nipTag = (tagValue("N") ?: "").trim()
	if (nipTag.isNotEmpty() && !nipTag.split(",").any { it.trim() == "1" }) return null
	var rttTag: String? = null
	for (tag in tags) {
		val arr = tag as? List<*> ?: continue
		val key = arr.getOrNull(0)?.toString() ?: continue
		if (Regex("^rtt-(open|read|write)$").matches(key)) {
			rttTag = arr.getOrNull(1)?.toString()
			break
		}
	}
	val rtt = rttTag?.toDoubleOrNull()
	return linkedMapOf(
		"url" to url,
		"clearnet" to clearnet,
		"rttMs" to if (rtt != null && !rtt.isNaN() && !rtt.isInfinite()) maxOf(0.0, minOf(MAX_RTT_MS.toDouble(), Math.round(rtt).toDouble())) else null,
		"pubkey" to (obj["pubkey"]?.toString() ?: ""),
	)
}

/**
 * probe 一个 relay：建立连接测 open RTT，读取 NIP-11 信息。成功更新统计。
 *
 * JVM 参考实现基于注入的 [WebSocketProvider]；未注入时返回 null。
 * @param url relay URL
 * @param signal 取消信号
 * @return 成功信息或 null
 */
@JvmOverloads
suspend fun probeRelay(url: String, signal: AbortSignalLike? = null): Map<String, Any?>? {
	val normalized = normalizeNostrRelayUrl(url) ?: return null
	val connectTarget = resolveRelayConnectTarget(normalized) ?: return null
	val startedAt = System.currentTimeMillis()
	var ws: WebSocketConnection? = null
	try {
		ws = connectRelay(normalized, PROBE_TIMEOUT_MS, signal, connectTarget)
		val rttMs = System.currentTimeMillis() - startedAt
		val info = queryRelayInfo(normalized, signal)
		recordProbeSuccess(normalized, rttMs.toDouble())
		return linkedMapOf("url" to normalized, "rttMs" to rttMs.toDouble(), "nips" to info)
	}
	catch (_: Exception) {
		recordProbeFailure(normalized)
		return null
	}
	finally {
		if (ws != null) runCatching { if (ws.readyState != WS_CLOSED) ws.terminate() }
	}
}

private class RelayHttpResponse(val status: Int, val location: String, val body: String)

private fun relayInfoRequest(url: String, signal: AbortSignalLike?): RelayHttpResponse? {
	return try {
		val parsed = URI(url)
		val connection = URL(url).openConnection() as HttpURLConnection
		connection.requestMethod = "GET"
		connection.setRequestProperty("Accept", "application/nostr+json")
		connection.connectTimeout = 4000
		connection.readTimeout = 4000
		val status = connection.responseCode
		val stream = if (status in 200..399) connection.inputStream else connection.errorStream
		val body = stream?.readBytes()?.let { String(it, Charsets.UTF_8) } ?: ""
		RelayHttpResponse(status, connection.getHeaderField("Location") ?: "", body.take(64 * 1024))
	}
	catch (_: Exception) {
		null
	}
}

/**
 * 拉取单个 relay 的 NIP-11 relay info（supported_nips）。
 * @param relayUrl relay URL
 * @param signal 取消信号
 * @return NIP-11 信息
 */
private fun queryRelayInfo(relayUrl: String, signal: AbortSignalLike?): List<String> {
	val httpUrl = relayUrl.replace(Regex("^wss:"), "https:").replace(Regex("^ws:"), "http:")
	try {
		val response = relayInfoRequest(httpUrl, signal) ?: return emptyList()
		if (response.status >= 300) return emptyList()
		val info = io.github.steve02081504.fountp2p.core.Json.parse(response.body) as? Map<*, *> ?: return emptyList()
		val nips = info["supported_nips"] as? List<*> ?: return emptyList()
		return nips.mapNotNull { it?.toString() }
	}
	catch (_: Exception) {
		return emptyList()
	}
}

/**
 * 执行一轮 NIP-66 中继发现（可取消）。
 *
 * JVM 实现受注入的 [WebSocketProvider] / DNS 解析器约束。
 * @param signal 取消信号
 * @return 新入库的中继数量
 */
@JvmOverloads
suspend fun discoverNostrRelays(signal: AbortSignalLike? = null): Int {
	val bootstrap = dedupeRelayUrls(
		(if (bootstrapRelaysOverride.isNotEmpty()) bootstrapRelaysOverride else NIP66_BOOTSTRAP_RELAYS) + getPinnedRelays(),
	)
	if (bootstrap.isEmpty()) return 0
	val candidates = LinkedHashMap<String, MutableMap<String, Any?>>()
	for (relayUrl in bootstrap) {
		try {
			collectNip66Events(relayUrl, signal) { candidate ->
				val url = candidate["url"] as String
				val existing = candidates[url]
				if (existing != null) {
					existing["count"] = ((existing["count"] as Int) + 1)
					if ((candidate["pubkey"] as String).isNotEmpty())
						existing["pubkey"] = if ((existing["pubkey"] as String).isEmpty()) candidate["pubkey"] else existing["pubkey"]
				}
				else candidates[url] = mutableMapOf(
					"url" to url,
					"count" to 1,
					"rttMs" to candidate["rttMs"],
					"pubkey" to candidate["pubkey"],
				)
			}
		}
		catch (_: Exception) {
			// skip bad bootstrap
		}
	}
	var added = 0
	var probedCount = 0
	val pending = ArrayList<MutableMap<String, Any?>>()
	for (candidate in candidates.values)
		if (isRelayDestinationAllowed(candidate["url"] as String)) pending.add(candidate)
	while (pending.isNotEmpty() && probedCount < MAX_NIP66_PROBES_PER_ROUND && signal?.aborted != true) {
		val batchSize = minOf(NIP66_PROBE_BATCH_SIZE, MAX_NIP66_PROBES_PER_ROUND - probedCount)
		val batch = pending.take(batchSize)
		repeat(batch.size) { pending.removeAt(0) }
		probedCount += batch.size
		for (candidate in batch) {
			val probed = try {
				probeRelay(candidate["url"] as String, signal)
			}
			catch (_: Exception) {
				null
			} ?: continue
			upsertRelay(
				mapOf(
					"url" to probed["url"],
					"rttMs" to probed["rttMs"],
					"source" to "nip66",
					"monitorCount" to candidate["count"],
					"nips" to probed["nips"],
					"clearnet" to true,
					"lastProbe" to System.currentTimeMillis().toDouble(),
					"lastSuccess" to System.currentTimeMillis().toDouble(),
				),
			)
			added++
		}
	}
	return added
}

private suspend fun collectNip66Events(
	relayUrl: String,
	signal: AbortSignalLike?,
	onCandidate: (Map<String, Any?>) -> Unit,
) {
	val connectTarget = resolveRelayConnectTarget(relayUrl) ?: return
	val ws = connectRelay(relayUrl, PROBE_TIMEOUT_MS, signal, connectTarget)
	try {
		val subId = "nip66-" + java.lang.Long.toString(System.nanoTime(), 36)
		val filters = listOf(
			linkedMapOf<String, Any?>("kinds" to listOf(30166.0), "limit" to NIP66_REQ_LIMIT.toDouble()),
			linkedMapOf<String, Any?>("kinds" to listOf(10166.0), "limit" to NIP66_REQ_LIMIT.toDouble()),
		)
		val done = kotlinx.coroutines.CompletableDeferred<Unit>()
		ws.onMessage = { data ->
			val parsed = try {
				io.github.steve02081504.fountp2p.core.Json.parse(data) as? List<*>
			}
			catch (_: Exception) {
				null
			}
			if (parsed != null) {
				if (parsed.getOrNull(0) == "EOSE") {
					if (!done.isCompleted) done.complete(Unit)
				}
				else if (parsed.getOrNull(0) == "EVENT") {
					val candidate = parseNip66Event(parsed.getOrNull(2))
					if (candidate != null) onCandidate(candidate)
				}
			}
		}
		ws.onClose = { if (!done.isCompleted) done.complete(Unit) }
		ws.onError = { if (!done.isCompleted) done.complete(Unit) }
		ws.send(io.github.steve02081504.fountp2p.core.Json.stringify(listOf("REQ", subId, filters)) ?: "")
		kotlinx.coroutines.withTimeoutOrNull(PROBE_TIMEOUT_MS) { done.await() }
	}
	finally {
		runCatching { if (ws.readyState != WS_CLOSED) ws.terminate() }
	}
}

/**
 * 启动周期 NIP-66 发现。
 * @param scope 运行作用域
 * @return 停止函数
 */
fun startNostrRelayDiscovery(scope: kotlinx.coroutines.CoroutineScope): () -> Unit {
	if (!discoveryEnabled) return {}
	var stopped = false
	val signal = AbortSignalLike()
	val job = scope.launch {
		delay(NIP66_REFRESH_MS)
		while (!stopped) {
			runCatching { discoverNostrRelays(signal) }
			delay(NIP66_REFRESH_MS)
		}
	}
	return {
		stopped = true
		signal.abort()
		job.cancel()
		Unit
	}
}

/** 立即刷新待写盘状态（测试用）。 */
fun flushRelayStateNow() {
	flushTimer?.cancel()
	flushTimer = null
	flushRelayState()
}

/**
 * 测试用：注入存储 IO 并复位池状态。
 * @param io 存储读写实现
 */
fun setRelayStorageIOForTests(io: RelayStorageIO) {
	storageIO = object : RelayStorageIO {
		override fun read(): Any? = try {
			io.read()
		}
		catch (_: Exception) {
			null
		}

		override fun write(data: Any?) = io.write(data)
	}
	resetNostrRelaysForTests()
}

/**
 * 测试用：禁用/启用 NIP-66 发现。
 * @param enabled 是否启用发现
 */
fun setNostrRelayDiscoveryEnabledForTests(enabled: Boolean) {
	discoveryEnabled = enabled
}

/**
 * 测试用：覆盖 NIP-66 引导集。
 * @param urls relay URL 列表
 */
fun setNip66BootstrapRelaysForTests(urls: List<String>?) {
	bootstrapRelaysOverride = (urls ?: emptyList()).mapNotNull { normalizeNostrRelayUrl(it) }
}

/** 测试用：清空池与 peerRoutes、定时器（不重播种）。 */
fun clearRelayPoolForTests() {
	flushTimer?.cancel()
	flushTimer = null
	poolEntries = LinkedHashMap()
	peerRoutes = LinkedHashMap()
	providerTrustedRelayUrls.clear()
	dirty = false
}

/** 测试用：清空池与 peerRoutes、定时器并重新播种默认。 */
fun resetNostrRelaysForTests() {
	flushTimer?.cancel()
	flushTimer = null
	poolEntries = LinkedHashMap()
	peerRoutes = LinkedHashMap()
	providerTrustedRelayUrls.clear()
	dirty = false
	seedPublicDefaults()
}
