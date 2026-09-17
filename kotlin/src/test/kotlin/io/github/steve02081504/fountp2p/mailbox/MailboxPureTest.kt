package io.github.steve02081504.fountp2p.mailbox

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * `mailbox/` 无独立 JS 纯测试的模块的补充覆盖：
 * importance / prune / settings / parse / rate / store 的可投递性判定。
 *
 * 另含 `test/integration/mailbox_integrate.test.mjs` 中不依赖 `deliver_or_store` 的部分。
 */
class MailboxPureTest {
	private val recipient = "a".repeat(64)

	@Test
	fun `normalizeMailboxSettings defaults and peer scaling`() {
		val defaults = normalizeMailboxSettings()
		assertEquals(3.0, defaults["maxHop"])
		assertEquals(3.0, defaults["relayFanoutTrusted"])
		assertEquals(3.0, defaults["relayFanoutNormal"])
		assertEquals(3.0, defaults["wantFanout"])

		val scaled = normalizeMailboxSettings(null, 100)
		assertEquals(30.0, scaled["relayFanoutTrusted"])
		assertEquals(3.0, scaled["relayFanoutNormal"])
		assertEquals(32.0, scaled["wantFanout"])
	}

	@Test
	fun `normalizeMailboxSettings clamps and honors explicit values`() {
		assertEquals(8.0, normalizeMailboxSettings(mapOf("maxHop" to 99.0))["maxHop"])
		assertEquals(3.0, normalizeMailboxSettings(mapOf("maxHop" to 0.0))["maxHop"])
		assertEquals(5.0, normalizeMailboxSettings(mapOf("relayFanoutTrusted" to 5.0))["relayFanoutTrusted"])
		assertEquals(10.0, normalizeMailboxSettings(mapOf("relayFanoutNormal" to 10.0))["relayFanoutNormal"])
		assertEquals(7.0, normalizeMailboxSettings(mapOf("wantFanout" to 7.0))["wantFanout"])
	}

	@Test
	fun `resolveMailboxRoutingForPeerCount halves in battery saver`() {
		val normal = resolveMailboxRoutingForPeerCount(100, null, false)
		assertEquals(false, normal["batterySaver"])
		val saver = resolveMailboxRoutingForPeerCount(100, null, true)
		assertEquals(true, saver["batterySaver"])
		assertEquals(3.0, saver["maxHop"])
		assertEquals(15.0, saver["relayFanoutTrusted"])
		assertEquals(2.0, saver["relayFanoutNormal"])
		assertEquals(16.0, saver["wantFanout"])
	}

	@Test
	fun `sortMailboxForRetention orders by tier then storedAt`() {
		val rows = listOf(
			mapOf<String, Any?>("id" to "normal", "tier" to "normal", "storedAt" to 100.0),
			mapOf<String, Any?>("id" to "trusted-late", "tier" to "trusted", "storedAt" to 200.0),
			mapOf<String, Any?>("id" to "quarantine", "tier" to "quarantine", "storedAt" to 50.0),
			mapOf<String, Any?>("id" to "trusted-early", "tier" to "trusted", "storedAt" to 10.0),
		)
		assertEquals(
			listOf("quarantine", "normal", "trusted-early", "trusted-late"),
			sortMailboxForRetention(rows).map { it["id"] },
		)
	}

	@Test
	fun `defaultTtlMsForTier and relay permission`() {
		assertEquals(30.0 * 24 * 3600 * 1000, defaultTtlMsForTier("trusted"), 0.0)
		assertEquals(7.0 * 24 * 3600 * 1000, defaultTtlMsForTier("normal"), 0.0)
		assertEquals(24.0 * 3600 * 1000, defaultTtlMsForTier("quarantine"), 0.0)
		assertEquals(false, allowMailboxRelayForTier("quarantine"))
		assertEquals(true, allowMailboxRelayForTier("normal"))
		assertEquals(true, allowMailboxRelayForTier("trusted"))
	}

	@Test
	fun `pruneMailboxBuckets caps bucket entries`() {
		val rows = (0 until 12).map { index ->
			mapOf<String, Any?>(
				"id" to index.toString(),
				"toPubKeyHash" to recipient,
				"fromNodeHash" to "b".repeat(64),
				"storedAt" to index.toDouble(),
			)
		}
		val kept = pruneMailboxBuckets(rows)
		assertEquals(MAX_BUCKET_ENTRIES, kept.size)
		assertEquals("2", kept.first()["id"])
		assertEquals("11", kept.last()["id"])
	}

	@Test
	fun `parseMailboxPut validates nodeHash hex`() {
		assertEquals(
			"invalid_payload",
			(parseMailboxPut("nope") as MailboxParseResult.Err).code,
		)
		assertEquals(
			"required",
			(parseMailboxPut(mapOf("other" to 1.0)) as MailboxParseResult.Err).code,
		)
		val badNetworkHash = parseMailboxPut(
			mapOf(
				"record" to mapOf<String, Any?>("toPubKeyHash" to recipient),
				"nodeHash" to "xyz",
			),
		)
		assertEquals("invalid_hex64", (badNetworkHash as MailboxParseResult.Err).code)
		assertEquals("nodeHash", badNetworkHash.field)
		val ok = parseMailboxPut(mapOf("record" to mapOf<String, Any?>("toPubKeyHash" to recipient)))
		assertEquals(true, ok.ok)
	}

	@Test
	fun `parseMailboxWant normalizes recipient`() {
		val ok = parseMailboxWant(mapOf<String, Any?>("toPubKeyHash" to recipient, "extra" to 1.0))
		assertEquals(true, ok.ok)
		if (ok is MailboxParseResult.Ok)
			assertEquals(recipient, ok.value["toPubKeyHash"])
		val bad = parseMailboxWant(mapOf("toPubKeyHash" to "nope"))
		assertEquals("invalid_hex64", (bad as MailboxParseResult.Err).code)
	}

	@Test
	fun `takeIncomingMailboxPutSlot enforces limits`() {
		val key = "c".repeat(64)
		val limits = mapOf<String, Any?>("maxPuts" to 2.0)
		assertEquals(true, takeIncomingMailboxPutSlot(key, limits))
		assertEquals(true, takeIncomingMailboxPutSlot(key, limits))
		assertEquals(false, takeIncomingMailboxPutSlot(key, limits))
		assertEquals(false, takeIncomingMailboxPutSlot("not-hex", limits))
	}

	@Test
	fun `isDeliverableMailboxRecord rejects quarantine and missing fields`() {
		assertEquals(true, isDeliverableMailboxRecord(mapOf("app" to "chat", "envelope" to mapOf("id" to "e1"), "tier" to "trusted")))
		assertEquals(true, isDeliverableMailboxRecord(mapOf("app" to "chat", "envelope" to mapOf("id" to "e1"), "tier" to "normal")))
		assertEquals(false, isDeliverableMailboxRecord(mapOf("app" to "chat", "envelope" to mapOf("id" to "e1"), "tier" to "quarantine")))
		assertEquals(false, isDeliverableMailboxRecord(mapOf("app" to "chat", "tier" to "trusted")))
		assertEquals(false, isDeliverableMailboxRecord(mapOf("envelope" to mapOf("id" to "e1"), "tier" to "trusted")))
	}
}
