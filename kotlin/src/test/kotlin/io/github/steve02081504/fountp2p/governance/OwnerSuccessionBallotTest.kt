package io.github.steve02081504.fountp2p.governance

import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.crypto.KeyPairBytes
import io.github.steve02081504.fountp2p.crypto.keyPairFromSeed
import io.github.steve02081504.fountp2p.crypto.pubKeyHash
import io.github.steve02081504.fountp2p.crypto.sign
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 群主继任联署选票验签测试。
 *
 * JS 侧 `js/governance/owner_succession_ballot.mjs` 暂无对应 `test/pure` 测试，
 * 此处按模块语义补测签名载荷稳定性与阈值判定。
 */
class OwnerSuccessionBallotTest {
	private fun coreBallot(): LinkedHashMap<String, Any?> = linkedMapOf(
		"proposedOwnerPubKeyHash" to "ab".repeat(32),
		"groupId" to "g-1",
		"ballotId" to "ballot-1",
	)

	private fun entryFor(keyPair: KeyPairBytes, core: Map<String, Any?>): Map<String, Any?> =
		linkedMapOf(
			"pubKeyHex" to bytesToHex(keyPair.publicKey),
			"signature" to bytesToHex(sign(ownerSuccessionBallotSignBytes(core), keyPair.secretKey)),
		)

	@Test
	fun `verifyOwnerSuccessionThreshold accepts single admin by majority`() {
		val keyPair = keyPairFromSeed(ByteArray(32) { 7 })
		val adminHash = pubKeyHash(keyPair.publicKey)
		val core = coreBallot()
		val ballot = LinkedHashMap(core)
		ballot["adminSignatures"] = listOf(entryFor(keyPair, core))
		assertEquals(true, verifyOwnerSuccessionThreshold(ballot, setOf(adminHash)))
	}

	@Test
	fun `verifyOwnerSuccessionThreshold rejects below threshold and invalid input`() {
		val keyPair = keyPairFromSeed(ByteArray(32) { 9 })
		val adminHash = pubKeyHash(keyPair.publicKey)
		val otherHash = pubKeyHash(keyPairFromSeed(ByteArray(32) { 11 }).publicKey)
		val core = coreBallot()
		val ballot = LinkedHashMap(core)
		ballot["adminSignatures"] = listOf(entryFor(keyPair, core))

		assertEquals(false, verifyOwnerSuccessionThreshold(ballot, emptySet()))
		assertEquals(false, verifyOwnerSuccessionThreshold(ballot, setOf(adminHash), 0.0))
		assertEquals(false, verifyOwnerSuccessionThreshold(ballot, setOf(adminHash), 1.5))
		assertEquals(false, verifyOwnerSuccessionThreshold(ballot, setOf(adminHash, otherHash), 1.0))

		val tampered = LinkedHashMap(core)
		tampered["adminSignatures"] = listOf(
			linkedMapOf<String, Any?>(
				"pubKeyHex" to bytesToHex(keyPair.publicKey),
				"signature" to "0".repeat(128),
			),
		)
		assertEquals(false, verifyOwnerSuccessionThreshold(tampered, setOf(adminHash)))
	}
}
