package io.github.steve02081504.fountp2p.discovery

import io.github.steve02081504.fountp2p.core.normalizeTcpPort
import io.github.steve02081504.fountp2p.utils.TtlMap

/** LAN peer hint 存活时间。 */
const val LAN_PEER_HINT_TTL_MS: Long = 5L * 60_000

/** 单 peer 保留的 endpoint 上限。 */
private const val MAX_ENDPOINTS = 8

/** LAN 端点（host:port）。 */
data class LanEndpoint(val host: String, val port: Int)

private class LanHintEntry(val endpoints: List<LanEndpoint>)

private val hints = TtlMap<LanHintEntry>(LAN_PEER_HINT_TTL_MS)

/**
 * 记录 LAN 上观察到的 nodeHash → host:port。
 * 最新写入排在最前（dial / getLanPeerHint 优先用新观测）。
 * @param nodeHash 节点 64 hex
 * @param endpoint 端点
 */
fun noteLanPeerHint(nodeHash: String?, endpoint: LanEndpoint?) {
	val host = endpoint?.host ?: ""
	val port = normalizeTcpPort(endpoint?.port)
	if (nodeHash.isNullOrEmpty() || host.isEmpty() || port == null) return
	val existing = hints.get(nodeHash)?.endpoints ?: emptyList()
	val next = existing.filter { !(it.host == host && it.port == port) }
	val out = ArrayList<LanEndpoint>(next.size + 1)
	out.add(LanEndpoint(host, port))
	out.addAll(next)
	hints.set(nodeHash, LanHintEntry(out.take(MAX_ENDPOINTS)))
}

/**
 * 查询未过期的首个 LAN peer hint（最新观测）。
 * @param nodeHash 节点 64 hex
 * @param now 当前时间（测试可注入）
 * @return hint 或 null
 */
@JvmOverloads
fun getLanPeerHint(nodeHash: String?, now: Long = System.currentTimeMillis()): LanEndpoint? =
	listLanPeerHints(nodeHash, now).firstOrNull()

/**
 * 查询未过期的全部 LAN peer hint（最新在前）。
 * @param nodeHash 节点 64 hex
 * @param now 当前时间（测试可注入）
 * @return hint 列表
 */
@JvmOverloads
fun listLanPeerHints(nodeHash: String?, now: Long = System.currentTimeMillis()): List<LanEndpoint> {
	if (nodeHash.isNullOrEmpty()) return emptyList()
	return hints.get(nodeHash, now)?.endpoints ?: emptyList()
}

/** 清空全部 LAN peer hints（测试用）。 */
fun clearLanPeerHints() = hints.clear()
