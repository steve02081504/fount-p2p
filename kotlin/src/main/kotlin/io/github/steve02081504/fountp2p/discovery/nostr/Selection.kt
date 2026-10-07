package io.github.steve02081504.fountp2p.discovery.nostr

import io.github.steve02081504.fountp2p.node.shortHash
import kotlinx.coroutines.delay
import kotlin.random.Random

/**
 * 路由退避延迟（attempt 从 0 开始）。
 * @param attempt 尝试轮次
 * @return 退避毫秒
 */
fun backoffDelay(attempt: Int): Long {
	if (attempt <= 0) return 0
	return minOf(BACKOFF_BASE_MS * (1L shl (attempt - 1)), BACKOFF_CAP_MS.toLong())
}

/**
 * 计算对端声称的中继的「综合分」：本机健康分 + 对端上报 RTT。
 * @param url 对端 listen relay
 * @param route 对端路由
 * @return 综合分（越低越优）
 */
private fun compositeScore(url: String, route: PeerRoute?): Double {
	val ownPool = getPoolByUrl()[url]
	val own = if (ownPool != null) computeRelayHealth(ownPool) else DEFAULT_RTT_MS.toDouble()
	val peer = route?.peerPool?.find { it.url == url }?.rttMs ?: DEFAULT_RTT_MS.toDouble()
	return own + peer
}

/**
 * 对端声称的监听 relay 集，按综合分升序。
 * @param nodeHash 目标节点
 * @return 排序后的对端中继
 */
fun getReachPeerRelays(nodeHash: String): List<Map<String, Any?>> {
	val route = getPeerRoute(nodeHash) ?: return emptyList()
	if (route.listenRelays.isEmpty()) return emptyList()
	return route.listenRelays
		.map { linkedMapOf<String, Any?>("url" to it, "score" to compositeScore(it, route)) }
		.sortedBy { it["score"] as Double }
}

/**
 * 按健康分加权随机采样（权重 = 1/score，score 越低越可能被选）。
 * @param entries 候选
 * @param k 采样数量
 * @return 采样 URL
 */
fun weightedRandomSample(entries: List<RelayPoolEntry>, k: Int): List<String> {
	fun weightOf(entry: RelayPoolEntry): Double = maxOf(Double.MIN_VALUE, 1.0 / computeRelayHealth(entry))
	var total = entries.sumOf { weightOf(it) }
	val picked = ArrayList<String>()
	val remaining = ArrayList(entries)
	while (picked.size < k && remaining.isNotEmpty()) {
		var remainingWeight = Random.nextDouble() * total
		var position = 0
		for (index in remaining.indices) {
			val weight = weightOf(remaining[index])
			if (remainingWeight < weight) {
				position = index
				break
			}
			remainingWeight -= weight
		}
		val chosen = remaining.removeAt(position)
		picked.add(chosen.url)
		total -= weightOf(chosen)
	}
	return picked
}

/**
 * 从历史成功集 + 对端综合分补足，扩展至不超过 limit。
 * @param nodeHash 目标节点
 * @param base 基础 URL
 * @param limit 上限
 * @return 去重扩展结果
 */
fun expandFromHistory(nodeHash: String, base: List<String>, limit: Int): List<String> {
	val seen = HashSet<String>()
	val out = ArrayList<String>()
	for (url in base) {
		if (seen.contains(url)) continue
		seen.add(url)
		out.add(url)
		if (out.size >= limit) break
	}
	for (entry in getReachPeerRelays(nodeHash)) {
		val url = entry["url"] as String
		if (seen.contains(url)) continue
		seen.add(url)
		out.add(url)
		if (out.size >= limit) break
	}
	for (entry in getWorkingRelays()) {
		if (seen.contains(entry.url)) continue
		seen.add(entry.url)
		out.add(entry.url)
		if (out.size >= limit) break
	}
	return out.take(limit)
}

/**
 * 计算到指定节点的当前轮路由目标集。
 * @param nodeHash 目标节点
 * @param attempt 当前尝试轮次（0 起）
 * @return 目标集与退避
 */
fun handshakeTargets(nodeHash: String, attempt: Int): Map<String, Any?> {
	val seen = HashSet<String>()
	val targets = ArrayList<String>()
	fun push(url: String) {
		if (!seen.contains(url)) {
			seen.add(url)
			targets.add(url)
		}
	}

	if (attempt <= 0) {
		val reach = getReachPeerRelays(nodeHash)
		if (reach.isNotEmpty()) {
			for (entry in reach.take(ROUND0_TARGET_COUNT)) push(entry["url"] as String)
		}
		else {
			val working = getWorkingRelays()
			if (working.isNotEmpty()) for (entry in working.take(ROUND0_TARGET_COUNT)) push(entry.url)
		}
		return linkedMapOf("urls" to targets.take(MAX_ROUTING_FANOUT), "backoffDelay" to 0L)
	}
	val route = getPeerRoute(nodeHash)
	if (route != null && route.lastGoodNostrRelays.isNotEmpty())
		for (url in expandFromHistory(nodeHash, route.lastGoodNostrRelays, LAST_GOOD_RELAYS_MAX)) push(url)
	else
		for (url in weightedRandomSample(getWorkingRelays(), LAST_GOOD_RELAYS_MAX)) push(url)

	val reach = getReachPeerRelays(nodeHash)
	if (reach.isNotEmpty()) for (entry in reach.take(ROUND0_TARGET_COUNT)) push(entry["url"] as String)
	else for (entry in getWorkingRelays().take(ROUND0_TARGET_COUNT)) push(entry.url)

	return linkedMapOf("urls" to targets.take(MAX_ROUTING_FANOUT), "backoffDelay" to backoffDelay(attempt))
}

private fun recordPeerRouteLastGood(nodeHash: String, okRelays: List<String>) {
	val existing = getPeerRoute(nodeHash)?.lastGoodNostrRelays ?: emptyList()
	val merged = LinkedHashSet<String>()
	merged.addAll(existing)
	merged.addAll(okRelays)
	setPeerRoute(nodeHash, mapOf("lastGoodNostrRelays" to merged.take(LAST_GOOD_RELAYS_MAX)))
}

/**
 * 路由发布事件到目标节点：多 relay 并行，任一 OK 即记录 lastGood 并返回；全败则记录并退避重试。
 * @param toNodeHash 目标节点
 * @param event Nostr 事件
 * @param signal 取消信号
 * @return 是否成功发布
 */
@JvmOverloads
suspend fun routePublishEvent(toNodeHash: String, event: Map<String, Any?>, signal: AbortSignalLike? = null): Boolean {
	for (attempt in 0 until MAX_ROUTING_ATTEMPTS) {
		if (signal?.aborted == true) return false
		val targets = handshakeTargets(toNodeHash, attempt)
		@Suppress("UNCHECKED_CAST")
		val urls = targets["urls"] as List<String>
		val delayMs = targets["backoffDelay"] as Long
		if (urls.isEmpty()) return false
		val valid = urls.mapNotNull { url ->
			val target = try {
				resolveRelayConnectTarget(url)
			}
			catch (_: Exception) {
				null
			}
			if (target != null) Triple(url, target, 0) else null
		}
		if (valid.isEmpty()) return false
		val targetUrls = valid.map { it.first }
		val okRelays = ArrayList<String>()
		for ((url, target, _) in valid) {
			val ok = try {
				publishViaSharedRelay(url, event, signal, target)
			}
			catch (_: Exception) {
				false
			}
			if (ok) okRelays.add(url)
		}
		if (okRelays.isNotEmpty()) {
			recordPeerRouteLastGood(toNodeHash, okRelays)
			for (url in okRelays) recordPublishResult(url, true)
			io.github.steve02081504.fountp2p.node.nodeDebug(
				"p2p:nostr route ok",
				linkedMapOf("peer" to shortHash(toNodeHash), "attempt" to attempt.toDouble(), "relays" to okRelays),
			)
			return true
		}
		for (url in targetUrls) recordPublishResult(url, false)
		if (attempt >= MAX_ROUTING_ATTEMPTS - 1) return false
		if (signal?.aborted == true) return false
		delay(delayMs)
		if (signal?.aborted == true) return false
	}
	return false
}
