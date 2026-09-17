package io.github.steve02081504.fountp2p.timeline

import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.crypto.pubKeyHash
import io.github.steve02081504.fountp2p.crypto.publicKeyFromSeed
import io.github.steve02081504.fountp2p.dag.computeEventId
import io.github.steve02081504.fountp2p.dag.eventBodyForSign
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** `timeline/append_core.mjs` 行为测试（该 JS 模块无现成单测，按函数语义编写）。 */
class AppendCoreTest {
	private fun hex(c: Char): String = c.toString().repeat(64)

	private fun event(
		id: String,
		prev: List<String>,
		wall: Double,
		type: String = "message",
	): Map<String, Any?> = linkedMapOf(
		"id" to id,
		"type" to type,
		"prev_event_ids" to prev,
		"hlc" to mapOf("wall" to wall, "logical" to 0.0),
	)

	@Test
	fun `computeAppendHlcAndPrev returns empty prev and null last for no previous`() {
		val result = computeAppendHlcAndPrev(emptyList(), mapOf("timestamp" to 1_000.0))

		assertEquals(emptyList<String>(), result.prevEventIds)
		assertNull(result.last)
		assertTrue(result.hlc.containsKey("wall"))
		assertTrue(result.hlc.containsKey("logical"))
	}

	@Test
	fun `computeAppendHlcAndPrev sorts explicit prev_event_ids`() {
		val result = computeAppendHlcAndPrev(
			emptyList(),
			mapOf("timestamp" to 1_000.0, "prev_event_ids" to listOf(hex('b'), hex('a'))),
		)

		assertEquals(listOf(hex('a'), hex('b')), result.prevEventIds)
		assertNull(result.last)
	}

	@Test
	fun `computeAppendHlcAndPrev connects all DAG tips when no explicit prev`() {
		val a = hex('1')
		val b = hex('2')
		val previous = listOf(event(a, emptyList(), 1.0), event(b, emptyList(), 2.0))

		val result = computeAppendHlcAndPrev(previous, mapOf("timestamp" to 3.0), mapOf("multiTip" to true))

		assertEquals(listOf(a, b), result.prevEventIds)
		assertEquals(b, result.last?.get("id"))
	}

	@Test
	fun `computeAppendHlcAndPrev derives HLC from last event HLC`() {
		val e1 = hex('1')
		val previous = listOf(
			linkedMapOf<String, Any?>(
				"id" to e1,
				"prev_event_ids" to emptyList<String>(),
				"hlc" to mapOf("wall" to 5_000_000_000_000.0, "logical" to 3.0),
			),
		)

		val result = computeAppendHlcAndPrev(previous, mapOf("timestamp" to 5_000_000_000_000.0))

		assertEquals(5_000_000_000_000L, result.hlc["wall"])
		assertEquals(4L, result.hlc["logical"])
		assertEquals(listOf(e1), result.prevEventIds)
		assertEquals(e1, result.last?.get("id"))
	}

	@Test
	fun `signTimelineEvent computes id and verifies`() {
		val secretKey = ByteArray(32) { 7 }
		val publicKey = publicKeyFromSeed(secretKey)
		val base = linkedMapOf<String, Any?>(
			"type" to "message",
			"groupId" to hex('a'),
			"sender" to pubKeyHash(publicKey),
			"hlc" to mapOf("wall" to 1.0, "logical" to 0.0),
			"prev_event_ids" to listOf(hex('c')),
			"content" to "hello",
			"node_id" to hex('d'),
		)

		val signed = runBlocking { signTimelineEvent(base, secretKey) }

		assertEquals(computeEventId(eventBodyForSign(base)), signed["id"])
		assertEquals(bytesToHex(publicKey), signed["senderPubKey"])
		assertTrue(verifyTimelineRemoteSignature(signed))
	}
}
