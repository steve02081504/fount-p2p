package io.github.steve02081504.fountp2p.mailbox

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 等价 `test/pure/mailbox_deliver.test.mjs`（不含依赖 `deliver_or_store.mjs`/transport 的部分）。
 */
class MailboxDeliverTest {
	private val recipient = "a".repeat(64)

	@Test
	fun `dispatchMailboxRecordsToConsumers routes records by app`() = runBlocking {
		val username = "test-user"
		var seen: List<String> = emptyList()
		registerMailboxConsumer("chat") { _, records ->
			seen = records.map { it["id"] as String }
			listOf("a1")
		}
		registerMailboxConsumer("social") { _, _ -> listOf("b1") }
		try {
			val delivered = dispatchMailboxRecordsToConsumers(
				username,
				listOf(
					mapOf<String, Any?>(
						"id" to "r1",
						"app" to "chat",
						"envelope" to mapOf<String, Any?>("type" to "message"),
					),
				),
			)
			assertEquals(listOf("r1"), seen)
			assertEquals(setOf("a1"), delivered.toSet())
		}
		finally {
			unregisterMailboxConsumer("chat")
			unregisterMailboxConsumer("social")
		}
	}

	@Test
	fun `dispatchMailboxRecordsToConsumers merges consumer ids across apps`() = runBlocking {
		val username = "test-user"
		registerMailboxConsumer("chat") { _, records -> records.map { it["id"] as String } }
		registerMailboxConsumer("social") { _, records -> records.map { "social:${it["id"]}" } }
		try {
			val delivered = dispatchMailboxRecordsToConsumers(
				username,
				listOf(
					mapOf<String, Any?>("id" to "c1", "app" to "chat", "envelope" to mapOf<String, Any?>("type" to "message")),
					mapOf<String, Any?>("id" to "s1", "app" to "social", "envelope" to mapOf<String, Any?>("type" to "notify")),
				),
			)
			assertEquals(setOf("c1", "social:s1"), delivered.toSet())
		}
		finally {
			unregisterMailboxConsumer("chat")
			unregisterMailboxConsumer("social")
		}
	}

	@Test
	fun `parseMailboxGive rejects records without envelope or app`() {
		val missingEnvelope = parseMailboxGive(
			mapOf("records" to listOf(mapOf<String, Any?>("toPubKeyHash" to recipient))),
		)
		assertEquals(false, missingEnvelope.ok)
		if (missingEnvelope is MailboxParseResult.Err)
			assertEquals("records[0].envelope", missingEnvelope.field)

		val valid = parseMailboxGive(
			mapOf(
				"records" to listOf(
					mapOf<String, Any?>(
						"toPubKeyHash" to recipient,
						"app" to "chat",
						"envelope" to mapOf<String, Any?>("id" to "e1"),
					),
				),
			),
		)
		assertEquals(true, valid.ok)
		if (valid is MailboxParseResult.Ok)
			assertEquals(1, (valid.value["records"] as List<*>).size)
	}
}
