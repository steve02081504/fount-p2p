package io.github.steve02081504.fountp2p.federation

import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** 等价 `test/pure/want_ids.test.mjs`。 */
class WantIdsTest {
	@Test
	fun `resolveWantIdsLimits applies defaults and clamps bounds`() {
		val defaults = resolveWantIdsLimits()
		assertEquals(60_000.0, defaults["inWindowMs"])
		assertEquals(32.0, defaults["inMaxBatch"])
		assertEquals(60_000.0, defaults["outWindowMs"])
		assertEquals(16.0, defaults["outMaxBatch"])

		val clamped = resolveWantIdsLimits(
			mapOf(
				"inWindowMs" to 100,
				"inMaxBatch" to -5,
				"outWindowMs" to 50_000,
				"outMaxBatch" to 999,
			),
		)
		assertEquals(1000.0, clamped["inWindowMs"])
		assertEquals(1.0, clamped["inMaxBatch"])
		assertEquals(50_000.0, clamped["outWindowMs"])
		assertEquals(256.0, clamped["outMaxBatch"])
	}

	@Test
	fun `wantIdsPeerKey joins group and peer with null separator`() {
		assertEquals("group-a\u0000peer-b", wantIdsPeerKey("group-a", "peer-b"))
	}

	@Test
	fun `takeIncomingWantIdsSlot enforces per-peer batch limit and backoff`() {
		val groupId = "in-${UUID.randomUUID()}"
		val peerId = "peer-${UUID.randomUUID()}"
		val limits = mapOf("inMaxBatch" to 2, "inWindowMs" to 60_000)
		val peerKey = wantIdsPeerKey(groupId, peerId)

		assertEquals(true, takeIncomingWantIdsSlot(groupId, peerId, limits))
		assertEquals(true, takeIncomingWantIdsSlot(groupId, peerId, limits))
		assertEquals(false, takeIncomingWantIdsSlot(groupId, peerId, limits))
		assertTrue(isWantIdsInBackoff(peerKey))
	}

	@Test
	fun `takeOutgoingWantIdsSlot enforces per-group batch limit and backoff`() {
		val groupId = "out-${UUID.randomUUID()}"
		val limits = mapOf("outMaxBatch" to 2, "outWindowMs" to 60_000)

		assertEquals(true, takeOutgoingWantIdsSlot(groupId, limits))
		assertEquals(true, takeOutgoingWantIdsSlot(groupId, limits))
		assertEquals(false, takeOutgoingWantIdsSlot(groupId, limits))
		assertTrue(isWantIdsInBackoff(groupId))
	}

	@Test
	fun `batchWantIds caps list to budget`() {
		val ids = (0 until 40).map { "id-$it" }
		assertEquals(16, batchWantIds(ids, 16).size)
		assertEquals(ids.take(16), batchWantIds(ids, 0))
		assertEquals(ids.take(256), batchWantIds(ids, 300))
	}

	@Test
	fun `recordWantIdsBackoff grows delay up to 120s cap`() {
		val key = "backoff-${UUID.randomUUID()}"
		var now = 1_000_000L
		recordWantIdsBackoff(key, now)
		assertTrue(isWantIdsInBackoff(key, now))
		now += 2_000
		assertEquals(false, isWantIdsInBackoff(key, now))

		recordWantIdsBackoff(key, now)
		now += 4_000
		assertEquals(false, isWantIdsInBackoff(key, now))

		for (i in 0 until 8) recordWantIdsBackoff(key, now)
		val untilAfterStrike = now + 120_000
		recordWantIdsBackoff(key, now)
		now = untilAfterStrike - 1
		assertTrue(isWantIdsInBackoff(key, now))
		now = untilAfterStrike
		assertEquals(false, isWantIdsInBackoff(key, now))
	}
}
