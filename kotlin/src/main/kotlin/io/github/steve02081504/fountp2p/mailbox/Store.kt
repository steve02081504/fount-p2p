package io.github.steve02081504.fountp2p.mailbox

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.JsonUndefined
import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.core.isPlainObject
import io.github.steve02081504.fountp2p.dag.jsonlMutexKey
import io.github.steve02081504.fountp2p.dag.readJsonl
import io.github.steve02081504.fountp2p.dag.writeJsonl
import io.github.steve02081504.fountp2p.federation.jsNumber
import io.github.steve02081504.fountp2p.federation.jsNumberOr
import io.github.steve02081504.fountp2p.federation.jsString
import io.github.steve02081504.fountp2p.federation.jsTruthy
import io.github.steve02081504.fountp2p.node.mailboxStorePath
import io.github.steve02081504.fountp2p.utils.withAsyncMutex
import kotlin.math.floor
import kotlin.math.max

/**
 * Mailbox 存储转发 JSONL（`js/mailbox/store.mjs` 的等价实现）。
 *
 * 行为注意：JS `readAll` 会把合法 JSON 的非对象行也纳入（后续字段访问得 undefined）；
 * 本实现复用 [readJsonl]，只接受对象行、跳过其他行，实际 mailbox 记录均为对象。
 */

/** 单条 mailbox envelope JSON 字节上限 */
const val MAX_ENTRY_BYTES = 256 * 1024

/** 读取对象成员；缺失键返回 [JsonUndefined]，对应 JS `obj?.key`。 */
private fun member(map: Map<String, Any?>, key: String): Any? =
	if (map.containsKey(key)) map[key] else JsonUndefined

/**
 * @param value 入站 hop
 * @return 非负整数 hop
 */
fun normalizeMailboxHop(value: Any?): Int {
	val n = jsNumber(value)
	if (!n.isFinite()) return 0
	return max(0.0, floor(n)).toInt()
}

/** @return mailbox store 进程内互斥键 */
private fun mailboxStoreMutexKey(): String = jsonlMutexKey(mailboxStorePath())

/**
 * @param hop 转发跳数
 * @return 信誉分层
 */
fun mailboxTierFromHop(hop: Int): String = when {
	hop <= 0 -> "trusted"
	hop == 1 -> "normal"
	else -> "quarantine"
}

/**
 * @param row mailbox 记录
 * @return 是否可交给 Part 消费者（排除 quarantine 与缺字段）
 */
fun isDeliverableMailboxRecord(row: Any?): Boolean {
	if (!isPlainObject(Json.at(row, "envelope"))) return false
	if (!jsTruthy(Json.at(row, "app"))) return false
	val tier = Json.at(row, "tier")
	return tier == "trusted" || tier == "normal"
}

/**
 * @param record mailbox 记录
 * @return envelope 是否在存储限额内
 */
fun isMailboxRecordWithinSizeLimit(record: Any?): Boolean {
	val envelope = Json.at(record, "envelope")
	if (!isPlainObject(envelope)) return false
	return (Json.stringify(envelope) ?: "null").length <= MAX_ENTRY_BYTES
}

/**
 * 入站 wire 转发：不信任自报 hop，至少为 1；若本地已有同 id 则单调递增。
 * @param wireHop 线载荷 hop
 * @param existingStoredHop 本地已存 hop
 * @return 本节点存储 hop
 */
fun relayHopAfterWireIngress(wireHop: Any?, existingStoredHop: Any? = null): Int {
	val fromWire = max(normalizeMailboxHop(wireHop) + 1, 1)
	if (existingStoredHop == null || existingStoredHop === JsonUndefined || !jsNumber(existingStoredHop).isFinite())
		return fromWire
	return max(fromWire, normalizeMailboxHop(existingStoredHop) + 1)
}

/** @return 全部有效记录 */
private suspend fun readAll(): List<Map<String, Any?>> = readJsonl(mailboxStorePath())

/**
 * @param rows 待写入记录
 */
private suspend fun writeAll(rows: List<Map<String, Any?>>) {
	val now = System.currentTimeMillis().toDouble()
	val kept = pruneMailboxGlobalFair(
		pruneMailboxBuckets(
			sortMailboxForRetention(rows.filter { jsNumber(it["expiresAt"]) > now }),
		),
	)
	writeJsonl(mailboxStorePath(), kept)
}

/**
 * @param envelope 载荷
 * @return 稳定信封 id
 */
fun mailboxEnvelopeId(envelope: Any?): String {
	val raw = Json.at(envelope, "id")
	val id = if (jsTruthy(raw)) jsString(raw) else ""
	if (id.isEmpty()) throw IllegalArgumentException("mailbox envelope id required")
	return id
}

/**
 * @param record mailbox 记录字段
 * @return 是否新写入
 */
suspend fun storeMailboxRecord(record: Map<String, Any?>): Boolean {
	if (!isMailboxRecordWithinSizeLimit(record)) return false
	val toPubKeyHash = record["toPubKeyHash"] as? String ?: return false
	if (isHex64(toPubKeyHash) == null) return false
	val hop = normalizeMailboxHop(record["hop"])
	val tier = record["tier"] as? String ?: return false
	if (tier != "trusted" && tier != "normal" && tier != "quarantine") return false
	val appRaw = record["app"]
	val app = if (jsTruthy(appRaw)) jsString(appRaw) else ""
	if (app.isEmpty()) return false
	val id = try {
		mailboxEnvelopeId(record["envelope"])
	}
	catch (_: Exception) {
		return false
	}
	return withAsyncMutex(mailboxStoreMutexKey()) {
		val rows = readAll().toMutableList()
		if (rows.any { it["id"] == id }) return@withAsyncMutex false
		val ttlMs = jsNumberOr(jsNumber(member(record, "ttlMs")), defaultTtlMsForTier(tier))
		rows.add(
			linkedMapOf(
				"id" to id,
				"app" to app,
				"toPubKeyHash" to toPubKeyHash,
				"dmSessionTag" to (if (jsTruthy(record["dmSessionTag"])) jsString(record["dmSessionTag"]) else JsonUndefined),
				"groupId" to (if (jsTruthy(record["groupId"])) record["groupId"] else JsonUndefined),
				"channelId" to (if (jsTruthy(record["channelId"])) record["channelId"] else JsonUndefined),
				"envelope" to record["envelope"],
				"storedAt" to System.currentTimeMillis().toDouble(),
				"expiresAt" to (System.currentTimeMillis().toDouble() + ttlMs),
				"fromNodeHash" to (if (record.containsKey("fromNodeHash")) record["fromNodeHash"] else JsonUndefined),
				"hop" to hop.toDouble(),
				"tier" to tier,
				"importance" to (if (jsNumber(member(record, "importance")).isFinite()) jsNumber(member(record, "importance")) else JsonUndefined),
			),
		)
		writeAll(rows)
		true
	}
}

/**
 * @param toPubKeyHash 收件人
 * @return record id 列表
 */
suspend fun listMailboxIdsForRecipient(toPubKeyHash: String): List<String> =
	readAll().filter { it["toPubKeyHash"] == toPubKeyHash }.map { it["id"] as? String ?: "" }

/**
 * @param ids record id 列表
 * @return 匹配记录
 */
suspend fun getMailboxRecords(ids: List<String>): List<Map<String, Any?>> {
	val want = ids.map { jsString(it) }.toHashSet()
	return readAll().filter { want.contains(it["id"]) }
}

/**
 * @param ids 待删除 id
 */
suspend fun deleteMailboxRecords(ids: List<String>) {
	val drop = ids.map { jsString(it) }.toHashSet()
	withAsyncMutex(mailboxStoreMutexKey()) {
		writeAll(readAll().filter { !drop.contains(it["id"]) })
	}
}

/**
 * @param toPubKeyHash 收件人
 * @return 待发记录（不删除）
 */
suspend fun takeMailboxForRecipient(toPubKeyHash: String): List<Map<String, Any?>> =
	readAll().filter { it["toPubKeyHash"] == toPubKeyHash }

/**
 * @param toPubKeyHash 收件人 pubKeyHash
 * @return 未过期条数
 */
suspend fun countMailboxPendingForRecipient(toPubKeyHash: String): Int {
	val now = System.currentTimeMillis().toDouble()
	return readAll().count { it["toPubKeyHash"] == toPubKeyHash && jsNumber(it["expiresAt"]) > now }
}

/** @return 未过期条数 */
suspend fun countMailboxPending(): Int {
	val now = System.currentTimeMillis().toDouble()
	return readAll().count { jsNumber(it["expiresAt"]) > now }
}
