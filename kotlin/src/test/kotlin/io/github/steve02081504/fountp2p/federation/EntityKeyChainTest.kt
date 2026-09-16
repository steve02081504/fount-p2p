package io.github.steve02081504.fountp2p.federation

import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.core.hashFromPubKeyHex
import io.github.steve02081504.fountp2p.crypto.keyPairFromSeed
import io.github.steve02081504.fountp2p.crypto.randomBytes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 等价 `test/pure/entity_key_chain.test.mjs`。 */
class EntityKeyChainTest {
	@Test
	fun `recovery subject anchors entity identity`() {
		val recovery = keyPairFromSeed(randomBytes(32))
		val active = keyPairFromSeed(randomBytes(32))
		val recoveryHex = bytesToHex(recovery.publicKey)
		val activeHex = bytesToHex(active.publicKey)
		val subject = hashFromPubKeyHex(recoveryHex)
		assertEquals(subject, hashFromPubKeyHex(recoveryHex))
		assertEquals(true, isRecoverySender(recoveryHex, subject))
		assertEquals(true, isValidActiveSender(createGenesisKeyHistory(activeHex), hashFromPubKeyHex(activeHex)))
	}

	@Test
	fun `foldEntityKeyHistoryFromEvents tracks rotate`() {
		val active = keyPairFromSeed(randomBytes(32))
		val activeHex = bytesToHex(active.publicKey)
		val events = listOf<Any?>(
			mapOf(
				"type" to "entity_key_rotate",
				"content" to mapOf("generation" to 0, "activePubKeyHex" to activeHex),
				"hlc" to mapOf("wall" to 1),
				"timestamp" to 1,
			),
		)
		val folded = foldEntityKeyHistoryFromEvents(events)
		assertNull(folded.recoveryPubKeyHex)
		assertEquals(1, folded.entityKeyHistory.size)
	}

	@Test
	fun `rotate ignores missing generation instead of treating it as zero`() {
		val events = listOf<Any?>(
			mapOf(
				"type" to "entity_key_rotate",
				"content" to mapOf("activePubKeyHex" to "aa".repeat(32)),
				"timestamp" to 1,
			),
		)
		assertEquals(0, foldEntityKeyHistoryFromEvents(events).entityKeyHistory.size)
	}
}
