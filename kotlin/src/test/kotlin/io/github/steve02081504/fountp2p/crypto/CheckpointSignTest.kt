package io.github.steve02081504.fountp2p.crypto

import org.junit.Assert.assertEquals
import org.junit.Test

/** 等价 `test/pure/checkpoint_sign.test.mjs`。 */
class CheckpointSignTest {
	@Test
	fun `signCheckpoint roundtrip verifies`() {
		val keyPair = keyPairFromSeed(ByteArray(32) { 3 })
		val payload = mapOf<String, Any?>(
			"eventIdsInEpoch" to listOf("a".repeat(64)),
			"epoch_root_hash" to "b".repeat(64),
			"epoch_id" to 1,
		)
		val signed = signCheckpoint(payload, keyPair.secretKey)
		assertEquals(true, isSignedCheckpoint(signed))
		assertEquals(true, verifyCheckpointSignature(signed, keyPair.publicKey))
	}

	@Test
	fun `verifyCheckpointSignature rejects tampered signature`() {
		val keyPair = keyPairFromSeed(ByteArray(32) { 5 })
		val signed = signCheckpoint(mapOf("epoch_id" to 2), keyPair.secretKey)
		val bad = LinkedHashMap(signed)
		bad["checkpoint_signature"] = "c".repeat(128)
		assertEquals(false, verifyCheckpointSignature(bad, keyPair.publicKey))
	}

	@Test
	fun `isSignedCheckpoint rejects missing signature`() {
		assertEquals(false, isSignedCheckpoint(mapOf("epoch_id" to 1)))
		assertEquals(false, isSignedCheckpoint(null))
	}
}
