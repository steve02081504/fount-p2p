package io.github.steve02081504.fountp2p.node

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.JsonUndefined
import io.github.steve02081504.fountp2p.core.compositeKey
import io.github.steve02081504.fountp2p.core.isEntityHash128
import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.federation.jsString
import io.github.steve02081504.fountp2p.federation.jsTruthy
import io.github.steve02081504.fountp2p.utils.withAsyncMutex

/**
 * 节点连接拒绝（deny），非 Social block / 群 ban（等价 `node/denylist.mjs`）。
 *
 * scope：
 * - `subject`：pubKeyHash
 * - `entity`：entityHash（不使用 groupId）
 * - `node`：nodeHash
 */

private const val DATA_NAME = "denylist"

/** 内存索引：blocked 条目 + 复合键集合。 */
private class DenylistIndex(
	val blocked: List<Map<String, Any?>>,
	val keys: Set<String>,
)

private var cachedIndex: DenylistIndex? = null

/** @param mutator 突变 @return 串行化执行结果 */
private suspend fun <T> mutateDenylist(mutator: suspend () -> T): T = withAsyncMutex("denylist", mutator)

/** @return 索引键 */
private fun denyKey(scope: String, groupId: String, value: String): String =
	compositeKey(scope, groupId, value)

/** @param blocked 条目 @return 内存索引 */
private fun buildDenylistIndex(blocked: List<Map<String, Any?>>): DenylistIndex {
	val keys = LinkedHashSet<String>()
	for (entry in blocked) {
		val gid = (entry["groupId"] as? String).takeUnless { it.isNullOrEmpty() } ?: "*"
		val scope = entry["scope"] as? String ?: ""
		val value = entry["value"] as? String ?: ""
		if (scope == "entity") {
			keys.add(denyKey("entity", "*", value))
			continue
		}
		keys.add(denyKey(scope, gid, value))
	}
	return DenylistIndex(blocked, keys)
}

/** @return 缓存索引（必要时从磁盘加载） */
private fun getDenylistIndex(): DenylistIndex {
	cachedIndex?.let { return it }
	val raw = readNodeJsonSync(DATA_NAME) as? Map<String, Any?>
	val normalized = normalizeDenylist(raw)
	@Suppress("UNCHECKED_CAST")
	val blocked = normalized["blocked"] as List<Map<String, Any?>>
	val index = buildDenylistIndex(blocked)
	cachedIndex = index
	return index
}

/** 等价 JS `String(value || '')`。 */
private fun stringOrEmpty(value: Any?): String = when {
	value == null || value === JsonUndefined -> ""
	else -> jsString(value)
}

/** 等价 JS `String(value || fallback)`（falsy 时用 fallback）。 */
private fun stringOrEmptyOrDefault(value: Any?, fallback: String): String =
	if (jsTruthy(value)) jsString(value) else fallback

/** 等价 JS `entry.groupId || undefined`。 */
private fun normalizeOptionalGroupId(value: Any?): String? =
	if (jsTruthy(value)) jsString(value) else null

/** @return 条目 JSON */
private fun denylistEntry(scope: String, value: String, groupId: String? = null): Map<String, Any?> {
	val out = LinkedHashMap<String, Any?>()
	out["scope"] = scope
	out["value"] = value
	if (groupId != null) out["groupId"] = groupId
	return out
}

/**
 * @param raw 磁盘 JSON 或请求体
 * @return 规范化 denylist
 */
fun normalizeDenylist(raw: Map<String, Any?>?): Map<String, Any?> {
	val blocked = ArrayList<Map<String, Any?>>()
	val rawBlocked = Json.arr(raw?.get("blocked")) ?: emptyList()
	for (item in rawBlocked) {
		val entry = item as? Map<*, *>
		val scope = stringOrEmpty(entry?.get("scope"))
		val groupId = stringOrEmpty(entry?.get("groupId"))
		if (scope.isEmpty()) continue
		if (scope == "entity") {
			val value = isEntityHash128(entry?.get("value"))
			if (value != null) blocked.add(denylistEntry("entity", value))
			continue
		}
		val value = isHex64(entry?.get("value"))
		if (scope == "node" && value != null)
			blocked.add(denylistEntry("node", value, groupId.takeIf { it.isNotEmpty() }))
		else if (scope == "subject" && value != null)
			blocked.add(denylistEntry("subject", value, groupId.takeIf { it.isNotEmpty() }))
	}
	return linkedMapOf("blocked" to blocked)
}

/** @return 节点级 denylist */
fun loadDenylist(): Map<String, Any?> = linkedMapOf("blocked" to getDenylistIndex().blocked)

/** @param list denylist */
fun saveDenylist(list: Map<String, Any?>?) {
	val normalized = normalizeDenylist(list)
	writeNodeJsonSync(DATA_NAME, normalized)
	@Suppress("UNCHECKED_CAST")
	val blocked = normalized["blocked"] as List<Map<String, Any?>>
	cachedIndex = buildDenylistIndex(blocked)
}

/** 群物化状态中的 ban 集合（等价 JS `state.bannedMembers/bannedEntities/bannedNodes`）。 */
class GroupBanState(
	val bannedMembers: Set<String>? = null,
	val bannedEntities: Set<String>? = null,
	val bannedNodes: Set<String>? = null,
)

/**
 * @param state 物化群状态
 * @param subject 待检主体
 * @return 是否命中群级 ban 集合
 */
fun isSubjectBannedByState(state: GroupBanState?, subject: Map<String, Any?>?): Boolean {
	val pk = isHex64(subject?.get("pubKeyHash"))
	if (pk != null && state?.bannedMembers?.contains(pk) == true) return true
	val entity = isEntityHash128(subject?.get("entityHash"))
	if (entity != null && state?.bannedEntities?.contains(entity) == true) return true
	val node = isHex64(subject?.get("nodeHash"))
	if (node != null && state?.bannedNodes?.contains(node) == true) return true
	return false
}

/**
 * @param index 内存索引
 * @param subject 待检主体
 * @param groupId 可选群 scope
 * @return 是否命中
 */
private fun matchesDenylistIndex(index: DenylistIndex, subject: Map<String, Any?>?, groupId: String = ""): Boolean {
	val pk = isHex64(subject?.get("pubKeyHash"))
	val entity = stringOrEmpty(subject?.get("entityHash"))
	val node = isHex64(subject?.get("nodeHash"))
	val keys = index.keys

	if (entity.isNotEmpty() && keys.contains(denyKey("entity", "*", entity))) return true
	if (node != null && keys.contains(denyKey("node", "*", node))) return true
	if (pk != null && keys.contains(denyKey("subject", "*", pk))) return true
	if (groupId.isEmpty()) return false
	if (pk != null && keys.contains(denyKey("subject", groupId, pk))) return true
	if (node != null && keys.contains(denyKey("node", groupId, node))) return true
	return false
}

/**
 * @param subject 待检主体
 * @param groupId 可选群 scope
 * @return 是否在节点级 denylist 中（deny，非 Social block）
 */
fun isSubjectBlocked(subject: Map<String, Any?>?, groupId: String = ""): Boolean =
	matchesDenylistIndex(getDenylistIndex(), subject, groupId)

/**
 * @param groupId 群 ID
 * @param peerKey pubKeyHash 或 nodeHash（按 scope 分别匹配，不混填）
 * @return 是否拉黑
 */
fun isPeerKeyBlocked(groupId: String, peerKey: Any?): Boolean {
	val key = isHex64(peerKey) ?: return false
	val index = getDenylistIndex()
	val keys = index.keys
	if (keys.contains(denyKey("subject", "*", key))) return true
	if (keys.contains(denyKey("node", "*", key))) return true
	if (groupId.isEmpty()) return false
	if (keys.contains(denyKey("subject", groupId, key))) return true
	if (keys.contains(denyKey("node", groupId, key))) return true
	return false
}

/** @param pubKeyHash 64 位十六进制 @return 是否拉黑该 subject */
fun isPubKeyHashBlocked(pubKeyHash: Any?): Boolean = isSubjectBlocked(mapOf("pubKeyHash" to pubKeyHash))

/** @param entityHash 128 位十六进制 @return 是否拉黑该 entity */
fun isEntityHashBlocked(entityHash: Any?): Boolean = isSubjectBlocked(mapOf("entityHash" to entityHash))

/**
 * 追加拉黑并落盘。
 * @param entry 拉黑项
 */
suspend fun addDenylistEntry(entry: Map<String, Any?>) {
	val scope = stringOrEmpty(entry["scope"])
	if (scope.isEmpty()) throw IllegalArgumentException("scope and value required")
	if (scope == "entity" && jsTruthy(entry["groupId"]))
		throw IllegalArgumentException("entity scope does not use groupId")
	val normValue = entry["value"]
	if (!jsTruthy(normValue)) throw IllegalArgumentException("scope and value required")
	if (scope == "subject" && isHex64(normValue) == null)
		throw IllegalArgumentException("invalid pubKeyHash")
	if (scope == "entity" && isEntityHash128(normValue) == null)
		throw IllegalArgumentException("invalid entityHash")
	if (scope == "node" && isHex64(normValue) == null)
		throw IllegalArgumentException("invalid nodeHash")

	val groupId = normalizeOptionalGroupId(entry["groupId"])
	val value = jsString(normValue)
	mutateDenylist {
		val list = loadDenylist()
		@Suppress("UNCHECKED_CAST")
		val blocked = ArrayList(list["blocked"] as List<Map<String, Any?>>)
		val exists = blocked.any {
			it["scope"] == scope && it["value"] == value && normalizeOptionalGroupId(it["groupId"]) == groupId
		}
		if (exists) return@mutateDenylist
		blocked.add(denylistEntry(scope, value, groupId))
		saveDenylist(linkedMapOf("blocked" to blocked))
	}
}

/**
 * @param banContent member_ban 内容
 * @param groupId 来源群
 */
suspend fun addDenylistFromBanContent(banContent: Map<String, Any?>?, groupId: String?) {
	val scope = stringOrEmptyOrDefault(banContent?.get("banScope"), "entity")
	val sourceGroupId = groupId ?: ""
	if (scope == "entity" && jsTruthy(banContent?.get("targetEntityHash")))
		addDenylistEntry(mapOf("scope" to "entity", "value" to banContent?.get("targetEntityHash")))
	if (scope == "node" && jsTruthy(banContent?.get("targetNodeHash")))
		addDenylistEntry(mapOf("scope" to "node", "value" to banContent?.get("targetNodeHash")))
	val pk = isHex64(banContent?.get("targetPubKeyHash"))
	if (pk != null) {
		val entry = LinkedHashMap<String, Any?>()
		entry["scope"] = "subject"
		entry["value"] = pk
		if (sourceGroupId.isNotEmpty()) entry["groupId"] = sourceGroupId
		addDenylistEntry(entry)
	}
}

/**
 * 追加群 scope 拉黑项。
 * @param groupId 群 ID
 * @param scope subject | entity | node 作用域
 * @param value 键值
 */
suspend fun addGroupBlockedPeer(groupId: String, scope: String, value: String) {
	if (scope == "entity") addDenylistEntry(mapOf("scope" to scope, "value" to value))
	else addDenylistEntry(mapOf("scope" to scope, "value" to value, "groupId" to groupId))
}

/**
 * @param groupId 群 ID
 * @param scope subject | entity | node 作用域
 * @param value 键值
 */
suspend fun removeGroupBlockedPeer(groupId: String, scope: String?, value: String?) {
	if (scope.isNullOrEmpty() || value.isNullOrEmpty()) return
	mutateDenylist {
		val list = loadDenylist()
		@Suppress("UNCHECKED_CAST")
		val blocked = list["blocked"] as List<Map<String, Any?>>
		val filtered = blocked.filter { entry ->
			if (entry["scope"] != scope || entry["value"] != value) return@filter true
			if (scope == "entity") return@filter false
			normalizeOptionalGroupId(entry["groupId"]) != groupId
		}
		saveDenylist(linkedMapOf("blocked" to filtered))
	}
}

/**
 * @param groupId 群 ID
 * @param entries 拉黑条目
 */
suspend fun addGroupBlockedPeers(groupId: String, entries: List<Map<String, Any?>?>) {
	for (entry in entries) {
		val scope = entry?.get("scope") as? String
		val value = entry?.get("value") as? String
		if (scope.isNullOrEmpty() || value.isNullOrEmpty()) continue
		addGroupBlockedPeer(groupId, scope, value)
	}
}
