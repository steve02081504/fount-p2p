package io.github.steve02081504.fountp2p.federation

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.canonicalStringify
import io.github.steve02081504.fountp2p.core.hashFromPubKeyHex
import io.github.steve02081504.fountp2p.core.isHex64

/**
 * Entity 密钥历史链：entityHash 锚定 recovery 公钥，活跃钥可轮换。
 */

/** entity 密钥撤销签名的域分隔前缀。 */
const val ENTITY_KEY_REVOKE_DOMAIN = "fount-entity-key-revoke"

/** 密钥历史条目（JSON 对象形态：generation / activePubKeyHex / attestedBy / validFrom? / revokedGenerations?）。 */
typealias EntityKeyHistoryEntry = MutableMap<String, Any?>

/**
 * @param activePubKeyHex 初始活跃公钥
 * @param validFrom 生效时间
 * @return 创世链
 */
fun createGenesisKeyHistory(activePubKeyHex: Any?, validFrom: Long = System.currentTimeMillis()): MutableList<EntityKeyHistoryEntry> {
	if (!jsTruthy(activePubKeyHex)) return mutableListOf()
	return mutableListOf(
		linkedMapOf(
			"generation" to 0.0,
			"activePubKeyHex" to activePubKeyHex,
			"attestedBy" to "recovery",
			"validFrom" to validFrom.toDouble(),
		),
	)
}

/**
 * @param keyHistory 密钥历史
 * @param generation 代际
 * @return 活跃公钥 hex；未命中 null
 */
fun resolveActiveKeyAtGeneration(keyHistory: List<EntityKeyHistoryEntry>, generation: Any?): String? {
	val target = jsNumber(generation)
	val entry = keyHistory.firstOrNull { jsNumber(it["generation"]) == target } ?: return null
	return entry["activePubKeyHex"] as? String
}

/**
 * @param keyHistory 密钥历史
 * @param generation 代际
 * @return 是否已吊销
 */
fun isActiveGenerationRevoked(keyHistory: List<EntityKeyHistoryEntry>, generation: Any?): Boolean {
	val target = jsNumber(generation)
	for (entry in keyHistory) {
		val revoked = entry["revokedGenerations"] as? List<*> ?: continue
		if (revoked.any { jsNumber(it) == target }) return true
	}
	return false
}

/**
 * @param keyHistory 密钥历史
 * @param senderPubKeyHash 事件 sender（64 hex pubKeyHash）
 * @return sender 是否为未吊销的活跃钥
 */
fun isValidActiveSender(keyHistory: List<EntityKeyHistoryEntry>?, senderPubKeyHash: Any?): Boolean {
	val sender = isHex64(senderPubKeyHash) ?: return false
	val history = keyHistory ?: emptyList()
	for (entry in history) {
		if (isActiveGenerationRevoked(history, entry["generation"])) continue
		if (hashFromPubKeyHex(entry["activePubKeyHex"]) == sender) return true
	}
	return false
}

/**
 * @param recoveryPubKeyHex recovery 公钥
 * @param senderPubKeyHash 事件 sender
 * @return 是否为 recovery 钥签名
 */
fun isRecoverySender(recoveryPubKeyHex: Any?, senderPubKeyHash: Any?): Boolean =
	hashFromPubKeyHex(recoveryPubKeyHex) == senderPubKeyHash

/**
 * @param state 物化状态
 * @param event entity_key_rotate 事件
 * @return 更新后状态
 */
fun reduceEntityKeyRotate(state: MutableMap<String, Any?>, event: Any?): MutableMap<String, Any?> {
	val content = Json.at(event, "content")
	val generation = jsNumber(jsonMember(content, "generation"))
	val activePubKeyHex = isHex64(Json.at(content, "activePubKeyHex"))
	if (!generation.isFinite() || generation < 0 || activePubKeyHex == null) return state
	val history = ensureEntityKeyHistory(state)
	if (history.any { jsNumber(it["generation"]) == generation }) return state
	history.add(
		linkedMapOf(
			"generation" to generation,
			"activePubKeyHex" to activePubKeyHex,
			"attestedBy" to if (generation == 0.0) "recovery" else "active",
			"validFrom" to validFromOf(event),
		),
	)
	return state
}

/**
 * @param state 物化状态
 * @param event entity_key_revoke 事件
 * @return 更新后状态
 */
@Suppress("UNCHECKED_CAST")
fun reduceEntityKeyRevoke(state: MutableMap<String, Any?>, event: Any?): MutableMap<String, Any?> {
	val content = Json.at(event, "content")
	val newGeneration = jsNumber(jsonMember(content, "newGeneration"))
	val activePubKeyHex = Json.at(content, "activePubKeyHex")
	val revokeGenerations = (Json.arr(Json.at(content, "revokeGenerations")) ?: emptyList())
		.map { jsNumber(it) }
		.filter { it.isFinite() }
	if (!newGeneration.isFinite() || newGeneration < 0 || isHex64(activePubKeyHex) == null) return state
	val history = ensureEntityKeyHistory(state)
	for (gen in revokeGenerations) {
		val entry = history.firstOrNull { jsNumber(it["generation"]) == gen } ?: continue
		val revoked = (entry["revokedGenerations"] as? MutableList<Any?>) ?: mutableListOf<Any?>().also {
			entry["revokedGenerations"] = it
		}
		if (revoked.none { jsNumber(it) == gen }) revoked.add(gen)
	}
	if (history.none { jsNumber(it["generation"]) == newGeneration }) {
		history.add(
			linkedMapOf(
				"generation" to newGeneration,
				"activePubKeyHex" to activePubKeyHex,
				"attestedBy" to "recovery",
				"validFrom" to validFromOf(event),
			),
		)
	}
	return state
}

/** 折叠结果：recovery 公钥与密钥历史。 */
data class EntityKeyFoldResult(
	val recoveryPubKeyHex: String?,
	val entityKeyHistory: MutableList<EntityKeyHistoryEntry>,
)

/**
 * @param events 时间线事件（拓扑序）
 * @return 折叠后的密钥链
 */
@Suppress("UNCHECKED_CAST")
fun foldEntityKeyHistoryFromEvents(events: List<Any?>?): EntityKeyFoldResult {
	var entityKeyHistory: MutableList<EntityKeyHistoryEntry> = mutableListOf()
	for (event in events ?: emptyList()) {
		when (Json.str(Json.at(event, "type"))) {
			"entity_key_rotate" -> {
				val state = mutableMapOf<String, Any?>("entityKeyHistory" to entityKeyHistory)
				reduceEntityKeyRotate(state, event)
				entityKeyHistory = state["entityKeyHistory"] as MutableList<EntityKeyHistoryEntry>
			}
			"entity_key_revoke" -> {
				val state = mutableMapOf<String, Any?>("entityKeyHistory" to entityKeyHistory)
				reduceEntityKeyRevoke(state, event)
				entityKeyHistory = state["entityKeyHistory"] as MutableList<EntityKeyHistoryEntry>
			}
		}
	}
	return EntityKeyFoldResult(null, entityKeyHistory)
}

/**
 * @param revokeBody 吊销正文
 * @return 固定域签名消息
 */
fun entityKeyRevokeSignBytes(revokeBody: Any?): ByteArray {
	val revokeGenerations = (Json.arr(Json.at(revokeBody, "revokeGenerations")) ?: emptyList()).map { jsNumber(it) }
	val rawActive = Json.at(revokeBody, "activePubKeyHex")
	val rawEntityHash = Json.at(revokeBody, "entityHash")
	val body = linkedMapOf<String, Any?>(
		"revokeGenerations" to revokeGenerations,
		"newGeneration" to jsNumber(Json.at(revokeBody, "newGeneration")),
		"activePubKeyHex" to if (jsTruthy(rawActive)) rawActive else "",
		"entityHash" to jsString(if (jsTruthy(rawEntityHash)) rawEntityHash else ""),
	)
	return "$ENTITY_KEY_REVOKE_DOMAIN\u0000${canonicalStringify(body)}".toByteArray(Charsets.UTF_8)
}

@Suppress("UNCHECKED_CAST")
private fun ensureEntityKeyHistory(state: MutableMap<String, Any?>): MutableList<EntityKeyHistoryEntry> {
	val existing = state["entityKeyHistory"]
	if (existing is MutableList<*>) return existing as MutableList<EntityKeyHistoryEntry>
	val created = mutableListOf<EntityKeyHistoryEntry>()
	state["entityKeyHistory"] = created
	return created
}

private fun validFromOf(event: Any?): Any? {
	val wall = Json.at(Json.at(event, "hlc"), "wall")
	return wall ?: Json.at(event, "timestamp")
}

/**
 * 读取对象成员，缺失键返回 `JsonUndefined`（对应 JS `obj?.key`），
 * 以便 `Number(...)` 区分 `undefined`（NaN）与显式 `null`（0）。
 * @param obj 对象
 * @param key 键
 * @return 成员值；缺失为 [io.github.steve02081504.fountp2p.core.JsonUndefined]
 */
private fun jsonMember(obj: Any?, key: String): Any? =
	if (obj is Map<*, *> && obj.containsKey(key)) obj[key] else io.github.steve02081504.fountp2p.core.JsonUndefined
