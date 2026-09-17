package io.github.steve02081504.fountp2p.mailbox

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.node.mailboxStorePath
import io.github.steve02081504.fountp2p.node.withTempNode
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Paths

/**
 * 等价 `test/integration/mailbox_store.test.mjs`（纯本地文件 I/O，不含 transport）。
 */
class MailboxStoreTest {
	private val recipient = "a".repeat(64)
	private val fromNode = "b".repeat(64)

	@Test
	fun `normalizeMailboxHop clamps negatives and non-integers`() {
		assertEquals(0, normalizeMailboxHop(-1))
		assertEquals(0, normalizeMailboxHop(-99))
		assertEquals(1, normalizeMailboxHop(1.9))
		assertEquals(0, normalizeMailboxHop("abc"))
		assertEquals(0, normalizeMailboxHop(Double.NaN))
	}

	@Test
	fun `negative hop normalized relay becomes hop 1 not trusted hop 0`() {
		val inbound = normalizeMailboxHop(-1)
		assertEquals(0, inbound)
		assertEquals(1, inbound + 1)
		assertEquals("normal", mailboxTierFromHop(inbound + 1))
	}

	@Test
	fun `storeMailboxRecord accepts quarantine tier at hop 2`() = runBlocking {
		withTempNode("fount-mailbox-") {
			val stored = storeMailboxRecord(
				mapOf<String, Any?>(
					"app" to "chat",
					"toPubKeyHash" to recipient,
					"envelope" to mapOf<String, Any?>("id" to "env-quarantine"),
					"hop" to 2.0,
					"tier" to "quarantine",
					"fromNodeHash" to fromNode,
				),
			)
			assertEquals(true, stored)
			val rows = getMailboxRecords(listOf("env-quarantine"))
			assertEquals(1, rows.size)
			assertEquals("quarantine", rows[0]["tier"])
			assertEquals(2.0, rows[0]["hop"])
		}
	}

	@Test
	fun `storeMailboxRecord concurrent writes keep both records`() = runBlocking {
		withTempNode("fount-mailbox-") {
			val results = coroutineScope {
				val first = async {
					storeMailboxRecord(
						mapOf<String, Any?>(
							"app" to "chat",
							"toPubKeyHash" to recipient,
							"envelope" to mapOf<String, Any?>("id" to "env-a"),
							"hop" to 0.0,
							"tier" to "trusted",
							"fromNodeHash" to fromNode,
						),
					)
				}
				val second = async {
					storeMailboxRecord(
						mapOf<String, Any?>(
							"app" to "chat",
							"toPubKeyHash" to recipient,
							"envelope" to mapOf<String, Any?>("id" to "env-b"),
							"hop" to 1.0,
							"tier" to "normal",
							"fromNodeHash" to fromNode,
						),
					)
				}
				listOf(first.await(), second.await())
			}
			assertEquals(listOf(true, true), results)
			val rows = getMailboxRecords(listOf("env-a", "env-b"))
			assertEquals(2, rows.size)
		}
	}

	@Test
	fun `relayHopAfterWireIngress enforces minimum hop 1 on wire`() {
		assertEquals(1, relayHopAfterWireIngress(-1))
		assertEquals(1, relayHopAfterWireIngress(0))
		assertEquals(2, relayHopAfterWireIngress(1))
		assertEquals(3, relayHopAfterWireIngress(0, 2))
	}

	@Test
	fun `isMailboxRecordWithinSizeLimit rejects oversized envelope`() {
		val big = "x".repeat(256 * 1024)
		assertEquals(
			false,
			isMailboxRecordWithinSizeLimit(mapOf("envelope" to mapOf<String, Any?>("id" to "e1", "body" to big))),
		)
		assertEquals(
			true,
			isMailboxRecordWithinSizeLimit(mapOf("envelope" to mapOf<String, Any?>("id" to "e1"))),
		)
	}

	@Test
	fun `readAll skips corrupt jsonl lines`() = runBlocking {
		withTempNode("fount-mailbox-") {
			val good = Json.stringify(
				mapOf<String, Any?>(
					"id" to "ok-line",
					"app" to "chat",
					"toPubKeyHash" to recipient,
					"envelope" to mapOf<String, Any?>("id" to "ok-line"),
					"storedAt" to System.currentTimeMillis().toDouble(),
					"expiresAt" to System.currentTimeMillis().toDouble() + 60_000,
					"fromNodeHash" to fromNode,
					"hop" to 0.0,
					"tier" to "trusted",
				),
			)!!
			val path = Paths.get(mailboxStorePath())
			path.parent?.let { Files.createDirectories(it) }
			Files.writeString(path, "$good\n{not json\n", Charsets.UTF_8)
			val rows = getMailboxRecords(listOf("ok-line"))
			assertEquals(1, rows.size)
			assertEquals("ok-line", rows[0]["id"])
		}
	}

	@Test
	fun `deleteMailboxRecords removes by envelope id`() = runBlocking {
		withTempNode("fount-mailbox-") {
			storeMailboxRecord(
				mapOf<String, Any?>(
					"app" to "chat",
					"toPubKeyHash" to recipient,
					"envelope" to mapOf<String, Any?>("id" to "env-del"),
					"hop" to 0.0,
					"tier" to "trusted",
					"fromNodeHash" to fromNode,
				),
			)
			deleteMailboxRecords(listOf("env-del"))
			assertEquals(0, getMailboxRecords(listOf("env-del")).size)
		}
	}
}
