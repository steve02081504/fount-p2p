package io.github.steve02081504.fountp2p.crypto

import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.dag.merkleRoot
import org.junit.Assert.assertEquals
import org.junit.Test

/** 等价 `test/pure/checkpoint_verify_remote.test.mjs`。 */
class CheckpointVerifyRemoteTest {
	@Test
	fun `verifyRemoteCheckpoint rejects missing checkpoint`() {
		val result = verifyRemoteCheckpoint(null)
		assertEquals(false, result.valid)
		assertEquals("checkpoint missing or not an object", result.reason)
	}

	@Test
	fun `verifyRemoteCheckpoint rejects empty eventIdsInEpoch`() {
		val result = verifyRemoteCheckpoint(
			mapOf(
				"eventIdsInEpoch" to emptyList<Any?>(),
				"epoch_root_hash" to "a".repeat(64),
				"checkpoint_signature" to "b".repeat(128),
				"epoch_id" to 1,
			),
		)
		assertEquals(false, result.valid)
		assertEquals("eventIdsInEpoch missing or empty", result.reason)
	}

	@Test
	fun `verifyRemoteCheckpoint rejects merkle mismatch`() {
		val result = verifyRemoteCheckpoint(
			mapOf(
				"eventIdsInEpoch" to listOf("a".repeat(64)),
				"epoch_root_hash" to "b".repeat(64),
				"checkpoint_signature" to "c".repeat(128),
				"epoch_id" to 1,
				"members_record" to mapOf("members" to emptyMap<String, Any?>(), "roles" to emptyMap<String, Any?>()),
			),
		)
		assertEquals(false, result.valid)
		assertEquals("epoch_root_hash does not match Merkle root of eventIdsInEpoch", result.reason)
	}

	@Test
	fun `verifyRemoteCheckpoint accepts valid signed checkpoint`() {
		val keyPair = keyPairFromSeed(ByteArray(32) { 11 })
		val founderHash = pubKeyHash(keyPair.publicKey)
		val pubHex = bytesToHex(keyPair.publicKey)
		val eventId = "a".repeat(64)
		val epochRoot = merkleRoot(listOf(eventId))
		val payload = mapOf<String, Any?>(
			"eventIdsInEpoch" to listOf(eventId),
			"epoch_root_hash" to epochRoot,
			"epoch_id" to 1,
			"members_record" to mapOf(
				"delegatedOwnerPubKeyHash" to founderHash,
				"members" to mapOf(founderHash to mapOf("pubKeyHex" to pubHex, "status" to "active")),
				"roles" to emptyMap<String, Any?>(),
			),
		)
		val signed = signCheckpoint(payload, keyPair.secretKey)
		val result = verifyRemoteCheckpoint(signed)
		assertEquals(true, result.valid)
	}
}
