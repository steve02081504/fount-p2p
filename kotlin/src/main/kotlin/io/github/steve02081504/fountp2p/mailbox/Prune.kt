package io.github.steve02081504.fountp2p.mailbox

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.federation.jsNumber
import io.github.steve02081504.fountp2p.federation.jsString
import io.github.steve02081504.fountp2p.federation.jsTruthy

/**
 * Mailbox 公平淘汰（纯函数，供 store 与单测复用）。
 *
 * 等价 `js/mailbox/prune.mjs`。
 */

/** 单收件人×发送者桶：条数上限 */
const val MAX_BUCKET_ENTRIES = 10

/** 单收件人×发送者桶：字节上限 */
const val MAX_BUCKET_BYTES = 2 * 1024 * 1024

/** 单用户 mailbox 全局条数上限。 */
const val MAX_MAILBOX_ENTRIES = 500

/** 单用户 mailbox 全局字节上限。 */
const val MAX_MAILBOX_BYTES = 50 * 1024 * 1024

/**
 * @param record 记录
 * @return JSON 序列化字节量（UTF-16 长度，等价 JS `JSON.stringify(record).length`）
 */
fun mailboxRecordBytes(record: Map<String, Any?>): Int = (Json.stringify(record) ?: "null").length

/**
 * @param record 记录
 * @return 公平淘汰桶键
 */
fun mailboxBucketKey(record: Map<String, Any?>): String {
	val to = record["toPubKeyHash"]
	val toText = if (jsTruthy(to)) jsString(to) else ""
	val from = record["fromNodeHash"]
	val fromText = if (jsTruthy(from)) jsString(from)
	else {
		val sender = Json.at(record["envelope"], "sender")
		if (jsTruthy(sender)) jsString(sender) else "unknown"
	}
	return "$toText\u0000$fromText"
}

/**
 * @param a 左记录
 * @param b 右记录
 * @return storedAt 升序比较结果（NaN 视为相等，等价 JS 排序器）
 */
private fun compareStoredAt(a: Map<String, Any?>, b: Map<String, Any?>): Int {
	val diff = jsNumber(a["storedAt"]) - jsNumber(b["storedAt"])
	return when {
		diff < 0 -> -1
		diff > 0 -> 1
		else -> 0
	}
}

/** storedAt 升序比较器（NaN 视为相等）。 */
private val STORED_AT_COMPARATOR = Comparator<Map<String, Any?>> { a, b -> compareStoredAt(a, b) }

/**
 * @param rows 记录列表
 * @return 按桶修剪后
 */
fun pruneMailboxBuckets(rows: List<Map<String, Any?>>): List<Map<String, Any?>> {
	val buckets = LinkedHashMap<String, MutableList<Map<String, Any?>>>()
	for (record in rows) {
		val key = mailboxBucketKey(record)
		buckets.getOrPut(key) { mutableListOf() }.add(record)
	}
	val out = mutableListOf<Map<String, Any?>>()
	for (list in buckets.values) {
		val bucket = list.sortedWith(STORED_AT_COMPARATOR).toMutableList()
		var bytes = bucket.sumOf { mailboxRecordBytes(it) }
		while (bucket.size > MAX_BUCKET_ENTRIES || bytes > MAX_BUCKET_BYTES) {
			if (bucket.isEmpty()) break
			val removed = bucket.removeAt(0)
			bytes -= mailboxRecordBytes(removed)
		}
		out.addAll(bucket)
	}
	return out
}

/**
 * @param rows 已按桶修剪后的记录
 * @return 全局限额内
 */
fun pruneMailboxGlobalFair(rows: List<Map<String, Any?>>): List<Map<String, Any?>> {
	var kept = rows.sortedWith(STORED_AT_COMPARATOR)
	var totalBytes = kept.sumOf { mailboxRecordBytes(it) }

	while ((kept.size > MAX_MAILBOX_ENTRIES || totalBytes > MAX_MAILBOX_BYTES) && kept.size > 1) {
		val buckets = LinkedHashMap<String, MutableList<Map<String, Any?>>>()
		for (record in kept) {
			val key = mailboxBucketKey(record)
			buckets.getOrPut(key) { mutableListOf() }.add(record)
		}
		var victimKey = ""
		var victimScore = -1L
		for ((key, list) in buckets) {
			val score = list.size.toLong() * 1_000_000L + list.sumOf { mailboxRecordBytes(it).toLong() }
			if (score > victimScore) {
				victimScore = score
				victimKey = key
			}
		}
		val victimList = buckets[victimKey] ?: emptyList()
		if (victimList.isEmpty()) break
		val sortedVictim = victimList.sortedWith(STORED_AT_COMPARATOR)
		val dropId = sortedVictim[0]["id"]
		kept = kept.filter { it["id"] != dropId }
		totalBytes = kept.sumOf { mailboxRecordBytes(it) }
	}

	if (kept.size > MAX_MAILBOX_ENTRIES)
		kept = kept.takeLast(MAX_MAILBOX_ENTRIES)
	return kept
}
