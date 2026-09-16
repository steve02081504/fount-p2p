package io.github.steve02081504.fountp2p.timeline

import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.crypto.keyPairFromSeed
import io.github.steve02081504.fountp2p.crypto.pubKeyHash
import io.github.steve02081504.fountp2p.crypto.sign
import io.github.steve02081504.fountp2p.dag.eventBodyForSign
import io.github.steve02081504.fountp2p.dag.signPayloadBytes
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `timeline/verify_remote.mjs` 行为测试（该 JS 模块无现成单测，按函数语义编写）。
 */
class VerifyRemoteTest {
	private fun signedEvent(seedByte: Byte = 7, content: String = "hello"): Map<String, Any?> {
		val keyPair = keyPairFromSeed(ByteArray(32) { seedByte })
		val base = linkedMapOf<String, Any?>(
			"type" to "message",
			"groupId" to "group-1",
			"channelId" to null,
			"sender" to pubKeyHash(keyPair.publicKey),
			"charId" to null,
			"timestamp" to 1000.0,
			"hlc" to mapOf("wall" to 1.0, "logical" to 0.0),
			"prev_event_ids" to emptyList<String>(),
			"content" to content,
			"node_id" to "node-1",
		)
		val signature = sign(signPayloadBytes(eventBodyForSign(base)), keyPair.secretKey)
		val out = LinkedHashMap(base)
		out["signature"] = bytesToHex(signature)
		out["senderPubKey"] = bytesToHex(keyPair.publicKey)
		return out
	}

	@Test
	fun `accepts valid signed event`() {
		assertTrue(verifyTimelineRemoteSignature(signedEvent()))
	}

	@Test
	fun `rejects null event`() {
		assertFalse(verifyTimelineRemoteSignature(null))
	}

	@Test
	fun `rejects malformed sender`() {
		val event = signedEvent().toMutableMap()
		event["sender"] = "not-a-hex"
		assertFalse(verifyTimelineRemoteSignature(event))
	}

	@Test
	fun `rejects malformed signature`() {
		val event = signedEvent().toMutableMap()
		event["signature"] = "deadbeef"
		assertFalse(verifyTimelineRemoteSignature(event))
	}

	@Test
	fun `rejects malformed sender pubkey`() {
		val event = signedEvent().toMutableMap()
		event["senderPubKey"] = "zz".repeat(32)
		assertFalse(verifyTimelineRemoteSignature(event))
	}

	@Test
	fun `rejects pubkey hash mismatch with sender`() {
		val event = signedEvent().toMutableMap()
		event["senderPubKey"] = bytesToHex(keyPairFromSeed(ByteArray(32) { 9 }).publicKey)
		assertFalse(verifyTimelineRemoteSignature(event))
	}

	@Test
	fun `rejects tampered content`() {
		val event = signedEvent().toMutableMap()
		event["content"] = "tampered"
		assertFalse(verifyTimelineRemoteSignature(event))
	}
}
