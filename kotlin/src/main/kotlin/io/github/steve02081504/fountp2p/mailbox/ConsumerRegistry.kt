package io.github.steve02081504.fountp2p.mailbox

import io.github.steve02081504.fountp2p.federation.jsString
import io.github.steve02081504.fountp2p.federation.jsTruthy

/**
 * Mailbox 投递成功后由 Part 消费 envelope（P2P 不解析 DAG）。
 *
 * 等价 `js/mailbox/consumer_registry.mjs`。JS handler 是 `async (username, records) => string[]`，
 * Kotlin 侧以挂起函数承载；返回 null 等价 JS `undefined`（`ids || []`）。
 */

/** @param username 副本用户名 @param records mailbox 记录 @return 已交付 record id 列表 */
typealias MailboxConsumer = suspend (username: String, records: List<Map<String, Any?>>) -> List<String>?

/** 已注册的 consumer。 */
private class MailboxConsumerEntry(val handler: MailboxConsumer)

/** app → consumer。 */
private val consumers = LinkedHashMap<String, MailboxConsumerEntry>()

/**
 * @param app 应用名（与 record.app 匹配）
 * @param handler 返回已交付 record id 列表
 */
fun registerMailboxConsumer(app: String, handler: MailboxConsumer) {
	consumers[app] = MailboxConsumerEntry(handler)
}

/**
 * @param app 应用名
 */
fun unregisterMailboxConsumer(app: String) {
	consumers.remove(app)
}

/**
 * @param username 副本用户名
 * @param records mailbox 记录
 * @return 所有 consumer 成功交付的 id 并集
 */
suspend fun dispatchMailboxRecordsToConsumers(
	username: String,
	records: List<Map<String, Any?>>,
): List<String> {
	val grouped = LinkedHashMap<String, MutableList<Map<String, Any?>>>()
	for (row in records) {
		val appValue = row["app"]
		val app = if (jsTruthy(appValue)) jsString(appValue) else ""
		if (app.isEmpty()) continue
		grouped.getOrPut(app) { mutableListOf() }.add(row)
	}
	val delivered = LinkedHashSet<String>()
	for ((app, entry) in consumers.entries.toList()) {
		val scoped = grouped[app]
		if (scoped.isNullOrEmpty()) continue
		try {
			val ids = entry.handler(username, scoped)
			for (id in ids ?: emptyList()) delivered.add(jsString(id))
		}
		catch (error: Throwable) {
			System.err.println("mailbox: consumer batch failed, retry per record $error")
			for (row in scoped)
				try {
					val ids = entry.handler(username, listOf(row))
					for (id in ids ?: emptyList()) delivered.add(jsString(id))
				}
				catch (rowErr: Throwable) {
					System.err.println("mailbox: consumer record failed $rowErr")
				}
		}
	}
	return delivered.toList()
}
