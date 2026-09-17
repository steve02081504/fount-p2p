package io.github.steve02081504.fountp2p.node

import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.core.parseEntityHash
import io.github.steve02081504.fountp2p.federation.jsString
import io.github.steve02081504.fountp2p.federation.jsTruthy

/**
 * 按实体的个人列表（等价 `node/personal_block.mjs`）。
 * **block**：对外联邦公开拉黑（timeline block 事件 + personal_block 索引）；
 * **hide**：纯本地隐藏（personal_hide.json，永不联邦）；
 * **mute**：本地静音（personal_mute.json）。
 *
 * `isWritableLocalEntity` 来自已移植的 `node/Identity.kt`（等价 `node/identity.mjs`）。
 */

/** 个人列表条目。 */
data class PersonalEntry(val scope: String, val value: String)

/** 内存过滤集（等价 `filterSetsFromPersonalListEntries` 返回值）。 */
class PersonalFilterSets(
	val blockedEntityHashes: MutableSet<String> = LinkedHashSet(),
	val blockedSubjects: MutableSet<String> = LinkedHashSet(),
	val hiddenEntityHashes: MutableSet<String> = LinkedHashSet(),
	val hiddenSubjects: MutableSet<String> = LinkedHashSet(),
	val mutedEntityHashes: MutableSet<String> = LinkedHashSet(),
	val mutedSubjects: MutableSet<String> = LinkedHashSet(),
)

private const val HIDE_JSON = "personal_hide.json"
private const val MUTE_JSON = "personal_mute.json"
private const val BLOCK_INDEX_JSON = "personal_block.json"

/**
 * @param targetEntityHash 128 位十六进制
 * @return 规范化条目
 */
fun entriesForTargetEntityHash(targetEntityHash: Any?): List<PersonalEntry> {
	val parsed = parseEntityHash(targetEntityHash) ?: return emptyList()
	val byKey = LinkedHashMap<String, PersonalEntry>()
	byKey["entity:${parsed.entityHash}"] = PersonalEntry("entity", parsed.entityHash)
	val subjectHash = isHex64(parsed.subjectHash)
	if (subjectHash != null) byKey["subject:$subjectHash"] = PersonalEntry("subject", subjectHash)
	return byKey.values.toList()
}

/**
 * @param raw 原始条目
 * @return 去重规范化
 */
fun normalizePersonalListEntries(raw: List<Any?>?): List<PersonalEntry> {
	val byKey = LinkedHashMap<String, PersonalEntry>()
	for (item in raw ?: emptyList()) {
		val entry = item as? Map<*, *> ?: continue
		val scope = if (jsTruthy(entry["scope"])) jsString(entry["scope"]) else ""
		if (scope == "entity") {
			val parsed = parseEntityHash(entry["value"])
			if (parsed != null) byKey["entity:${parsed.entityHash}"] = PersonalEntry("entity", parsed.entityHash)
		}
		else if (scope == "subject") {
			val value = isHex64(entry["value"])
			if (value != null) byKey["subject:$value"] = PersonalEntry("subject", value)
		}
	}
	return byKey.values.toList()
}

/** @return 条目 JSON（键序同 JS） */
private fun personalEntryToJson(entry: PersonalEntry): Map<String, Any?> =
	linkedMapOf("scope" to entry.scope, "value" to entry.value)

/** @return 按 `scope:value` 去重后的条目 */
private fun dedupePersonalEntries(entries: List<PersonalEntry>): List<PersonalEntry> {
	val byKey = LinkedHashMap<String, PersonalEntry>()
	for (entry in entries) byKey["${entry.scope}:${entry.value}"] = entry
	return byKey.values.toList()
}

/** @param data 实体 JSON @return `hidden`/`muted`/`blocked` 数组（缺省空） */
private fun listField(data: Any?, field: String): List<Any?> {
	val map = data as? Map<*, *> ?: return emptyList()
	return (map[field] as? List<Any?>) ?: emptyList()
}

/**
 * @param entries 列表
 * @param subject 待检主体
 * @return 是否命中列表
 */
fun matchesPersonalListEntries(entries: List<PersonalEntry>, subject: Map<String, Any?>?): Boolean {
	val entity = if (jsTruthy(subject?.get("entityHash"))) jsString(subject?.get("entityHash")) else ""
	val pkSource = if (jsTruthy(subject?.get("pubKeyHash"))) subject?.get("pubKeyHash") else subject?.get("subjectHash")
	val pk = if (jsTruthy(pkSource)) jsString(pkSource) else ""
	if (entity.isNotEmpty()) {
		for (entry in entries)
			if (entry.scope == "entity" && entry.value == entity) return true
		val parsed = parseEntityHash(entity)
		if (parsed != null)
			for (entry in entries)
				if (entry.scope == "subject" && entry.value == parsed.subjectHash) return true
	}
	if (isHex64(pk) != null)
		for (entry in entries)
			if (entry.scope == "subject" && entry.value == pk) return true
	return false
}

/** @param viewerEntityHash 观看者实体 @return 隐藏条目 */
suspend fun loadPersonalHideEntries(viewerEntityHash: String): List<PersonalEntry> {
	if (!isNodeInitialized()) return emptyList()
	val data = getEntityStore().readEntityJson(viewerEntityHash, HIDE_JSON)
	return normalizePersonalListEntries(listField(data, "hidden"))
}

/** @param viewerEntityHash 观看者实体 @return 静音条目 */
suspend fun loadPersonalMuteEntries(viewerEntityHash: String): List<PersonalEntry> {
	if (!isNodeInitialized()) return emptyList()
	val data = getEntityStore().readEntityJson(viewerEntityHash, MUTE_JSON)
	return normalizePersonalListEntries(listField(data, "muted"))
}

/** @param viewerEntityHash 观看者实体 @return 拉黑条目 */
suspend fun loadPersonalBlockEntries(viewerEntityHash: String): List<PersonalEntry> {
	if (!isNodeInitialized()) return emptyList()
	val data = getEntityStore().readEntityJson(viewerEntityHash, BLOCK_INDEX_JSON)
	return normalizePersonalListEntries(listField(data, "blocked"))
}

/**
 * @param viewerEntityHash 本地可写实体
 * @param targetEntityHash 目标
 * @param hide true=隐藏
 * @return 当前是否隐藏
 */
suspend fun setPersonalHidden(viewerEntityHash: String, targetEntityHash: String, hide: Boolean): Boolean {
	if (!isWritableLocalEntity(viewerEntityHash)) throw IllegalStateException("entity not writable on this replica")
	if (parseEntityHash(targetEntityHash) == null) throw IllegalArgumentException("invalid targetEntityHash")
	val store = getEntityStore()
	val current = normalizePersonalListEntries(listField(store.readEntityJson(viewerEntityHash, HIDE_JSON), "hidden"))
	val addEntries = entriesForTargetEntityHash(targetEntityHash)
	val addKeys = addEntries.map { "${it.scope}:${it.value}" }.toSet()
	val next = if (hide) dedupePersonalEntries(current + addEntries)
	else current.filter { "${it.scope}:${it.value}" !in addKeys }
	store.writeEntityJson(viewerEntityHash, HIDE_JSON, linkedMapOf("hidden" to next.map { personalEntryToJson(it) }))
	return hide
}

/**
 * @param viewerEntityHash 本地可写实体
 * @param targetEntityHash 目标
 * @param mute true=静音
 * @return 当前是否静音
 */
suspend fun setPersonalMuted(viewerEntityHash: String, targetEntityHash: String, mute: Boolean): Boolean {
	if (!isWritableLocalEntity(viewerEntityHash)) throw IllegalStateException("entity not writable on this replica")
	if (parseEntityHash(targetEntityHash) == null) throw IllegalArgumentException("invalid targetEntityHash")
	val store = getEntityStore()
	val current = normalizePersonalListEntries(listField(store.readEntityJson(viewerEntityHash, MUTE_JSON), "muted"))
	val addEntries = entriesForTargetEntityHash(targetEntityHash)
	val addKeys = addEntries.map { "${it.scope}:${it.value}" }.toSet()
	val next = if (mute) dedupePersonalEntries(current + addEntries)
	else current.filter { "${it.scope}:${it.value}" !in addKeys }
	store.writeEntityJson(viewerEntityHash, MUTE_JSON, linkedMapOf("muted" to next.map { personalEntryToJson(it) }))
	return mute
}

/**
 * @param viewerEntityHash 观看者实体
 * @param subject 待检主体
 * @return 是否被静音
 */
suspend fun isMutedBy(viewerEntityHash: String, subject: Map<String, Any?>?): Boolean =
	matchesPersonalListEntries(loadPersonalMuteEntries(viewerEntityHash), subject)

/**
 * 从物化公开拉黑名单同步本地索引（真相源 = 时间线 blocked 集）。
 * @param viewerEntityHash 实体
 * @param blockedEntityHashes 物化 blocked entityHash 列表
 */
suspend fun rebuildPersonalBlockIndex(viewerEntityHash: String, blockedEntityHashes: List<Any?>?) {
	if (!isWritableLocalEntity(viewerEntityHash)) return
	val byKey = LinkedHashMap<String, PersonalEntry>()
	for (raw in blockedEntityHashes ?: emptyList())
		for (entry in entriesForTargetEntityHash(raw))
			byKey["${entry.scope}:${entry.value}"] = entry
	getEntityStore().writeEntityJson(
		viewerEntityHash,
		BLOCK_INDEX_JSON,
		linkedMapOf("blocked" to byKey.values.map { personalEntryToJson(it) }),
	)
}

/**
 * 将 personal-lists API `{ entries }` 转为内存过滤集。
 * @param entries API 条目
 * @return 过滤集
 */
fun filterSetsFromPersonalListEntries(entries: List<Any?>?): PersonalFilterSets {
	val sets = PersonalFilterSets()
	for (item in entries ?: emptyList()) {
		val entry = item as? Map<*, *> ?: continue
		val kind = if (jsTruthy(entry["kind"])) jsString(entry["kind"]) else ""
		val scope = if (jsTruthy(entry["scope"])) jsString(entry["scope"]) else ""
		val value = if (jsTruthy(entry["value"])) jsString(entry["value"]) else ""
		if (value.isEmpty() || (scope != "entity" && scope != "subject")) continue
		when (kind) {
			"block" -> if (scope == "entity") sets.blockedEntityHashes.add(value) else sets.blockedSubjects.add(value)
			"hide" -> if (scope == "entity") sets.hiddenEntityHashes.add(value) else sets.hiddenSubjects.add(value)
			"mute" -> if (scope == "entity") sets.mutedEntityHashes.add(value) else sets.mutedSubjects.add(value)
		}
	}
	return sets
}

/**
 * @param viewerEntityHash 观看者实体
 * @return 过滤集
 */
suspend fun loadPersonalFilterSets(viewerEntityHash: String): PersonalFilterSets {
	if (viewerEntityHash.isEmpty()) return filterSetsFromPersonalListEntries(null)
	val blockedEntries = loadPersonalBlockEntries(viewerEntityHash)
	val hiddenEntries = loadPersonalHideEntries(viewerEntityHash)
	val mutedEntries = loadPersonalMuteEntries(viewerEntityHash)
	val combined = ArrayList<Any?>()
	combined.addAll(blockedEntries.map { linkedMapOf<String, Any?>("scope" to it.scope, "value" to it.value, "kind" to "block") })
	combined.addAll(hiddenEntries.map { linkedMapOf<String, Any?>("scope" to it.scope, "value" to it.value, "kind" to "hide") })
	combined.addAll(mutedEntries.map { linkedMapOf<String, Any?>("scope" to it.scope, "value" to it.value, "kind" to "mute") })
	return filterSetsFromPersonalListEntries(combined)
}

/**
 * @param filterSets loadPersonalFilterSets 结果
 * @param authorEntityHash 作者实体
 * @return 是否应过滤
 */
fun isAuthorFilteredByPersonalSets(filterSets: PersonalFilterSets, authorEntityHash: String?): Boolean {
	if (authorEntityHash.isNullOrEmpty()) return false
	if (filterSets.blockedEntityHashes.contains(authorEntityHash) ||
		filterSets.hiddenEntityHashes.contains(authorEntityHash) ||
		filterSets.mutedEntityHashes.contains(authorEntityHash)
	) return true
	val parsed = parseEntityHash(authorEntityHash) ?: return false
	if (filterSets.blockedSubjects.contains(parsed.subjectHash) ||
		filterSets.hiddenSubjects.contains(parsed.subjectHash) ||
		filterSets.mutedSubjects.contains(parsed.subjectHash)
	) return true
	return false
}
