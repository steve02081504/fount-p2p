package io.github.steve02081504.fountp2p.transport

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.JsonUndefined

/**
 * 群级 ICE/TURN 配置解析（groupSettings.iceServers → RTCPeerConnection / Trystero）。
 *
 * 等价 `js/transport/ice_servers.mjs`。
 */

private val ICE_URL_RE = Regex("^(stun|turn|turns):", RegexOption.IGNORE_CASE)
private const val MAX_ICE_SERVERS = 12

/** 默认 ICE 服务器（全局优先，区域 CN 作为回退）。 */
val DEFAULT_ICE_SERVERS: List<Map<String, Any?>> = listOf(
	mapOf("urls" to "stun:stun.l.google.com:19302"),
	mapOf("urls" to "stun:stun.cloudflare.com:3478"),
	mapOf("urls" to "stun:global.stun.twilio.com:3478"),
	mapOf("urls" to "stun:stun.nextcloud.com:3478"),
	mapOf("urls" to "stun:stun.voip.blackberry.com:3478"),
	mapOf("urls" to "stun:stun.freeswitch.org:3478"),
	mapOf("urls" to "stun:stun.chat.bilibili.com:3478"),
	mapOf("urls" to "stun:stun.hitv.com:3478"),
	mapOf("urls" to "stun:stun.miwifi.com:3478"),
)

/** 等价 JS `String(v || '')`：假值（null/undefined/0/NaN/''/false）记空串。 */
private fun jsOrEmptyString(value: Any?): String = when (value) {
	null, JsonUndefined -> ""
	is Boolean -> if (value) "true" else ""
	is String -> value
	is Number -> {
		val d = value.toDouble()
		if (d == 0.0 || d.isNaN()) "" else Json.jsNumberToString(d)
	}
	else -> value.toString()
}

/**
 * @param raw 单条 ICE 配置
 * @return 合法条目或 null
 */
private fun normalizeIceEntry(raw: Any?): Map<String, Any?>? {
	val obj = raw as? Map<*, *> ?: return null
	val urlsRaw = obj["urls"]
	val urlsList = if (urlsRaw is List<*>)
		urlsRaw.map { jsOrEmptyString(it) }.filter { it.isNotEmpty() }
	else
		listOf(jsOrEmptyString(urlsRaw)).filter { it.isNotEmpty() }
	if (urlsList.isEmpty()) return null
	for (u in urlsList)
		if (!ICE_URL_RE.containsMatchIn(u)) return null
	val username = obj["username"]?.let { it.toString() }
	val credential = obj["credential"]?.let { it.toString() }
	if ((!username.isNullOrEmpty() && credential.isNullOrEmpty()) || (username.isNullOrEmpty() && !credential.isNullOrEmpty()))
		return null
	val out = LinkedHashMap<String, Any?>()
	out["urls"] = if (urlsList.size == 1) urlsList[0] else urlsList
	if (!username.isNullOrEmpty()) {
		out["username"] = username
		out["credential"] = credential
	}
	return out
}

/**
 * @param groupSettings 物化群设置
 * @return 合法 ICE 列表
 */
fun resolveIceServers(groupSettings: Any?): List<Map<String, Any?>> {
	val fromSettings = (groupSettings as? Map<*, *>)?.get("iceServers") as? List<*> ?: emptyList<Any?>()
	val out = ArrayList<Map<String, Any?>>()
	for (raw in fromSettings) {
		val entry = normalizeIceEntry(raw) ?: continue
		out.add(entry)
		if (out.size >= MAX_ICE_SERVERS) break
	}
	return if (out.isNotEmpty()) out else ArrayList(DEFAULT_ICE_SERVERS)
}

/**
 * 校验并规范化待写入 DAG 的 iceServers 数组。
 * @param raw 请求体字段
 * @return 校验后的 ICE 列表
 */
fun sanitizeIceServersForSettings(raw: Any?): List<Map<String, Any?>> {
	val list = raw as? List<*> ?: emptyList<Any?>()
	if (list.isEmpty()) return ArrayList(DEFAULT_ICE_SERVERS)
	val out = ArrayList<Map<String, Any?>>()
	for (item in list) {
		val entry = normalizeIceEntry(item) ?: continue
		out.add(entry)
		if (out.size >= MAX_ICE_SERVERS) break
	}
	return if (out.isNotEmpty()) out else ArrayList(DEFAULT_ICE_SERVERS)
}
