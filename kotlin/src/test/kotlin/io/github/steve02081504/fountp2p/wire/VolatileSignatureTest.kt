package io.github.steve02081504.fountp2p.wire

import io.github.steve02081504.fountp2p.core.bytesToHex
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 对应 `js/wire/volatile_signature.mjs` 的等价测试。 */
class VolatileSignatureTest {
	@Test
	fun `boundStreamSlices bounds the chunk slice count`() {
		assertNull(boundStreamSlices(null))
		assertNull(boundStreamSlices(emptyList()))
		val max = List(MAX_STREAM_VOLATILE_SLICES) { it }
		assertEquals(max, boundStreamSlices(max))
		assertNull(boundStreamSlices(List(MAX_STREAM_VOLATILE_SLICES + 1) { it }))
	}

	@Test
	fun `streamChunkSignBytes matches the domain separated layout`() {
		val bytes = streamChunkSignBytes("stream-1", 1.0, emptyList())
		assertEquals("fount-volatile-chunk\u0000stream-1\u00001\u0000[]", bytes.toString(Charsets.UTF_8))
	}

	@Test
	fun `streamChunkSignBytes falls back to zero sequence for non finite values`() {
		val bytes = streamChunkSignBytes("stream-1", "abc", listOf(mapOf("a" to 1.0)))
		assertEquals("fount-volatile-chunk\u0000stream-1\u00000\u0000[{\"a\":1}]", bytes.toString(Charsets.UTF_8))
	}

	@Test
	fun `streamKeyPairFromUserSeed is deterministic per user material`() {
		val first = streamKeyPairFromUserSeed("alice", "secret")
		val second = streamKeyPairFromUserSeed("alice", "secret")
		assertArrayEquals(first.publicKey, second.publicKey)
		assertArrayEquals(first.secretKey, second.secretKey)
		val other = streamKeyPairFromUserSeed("bob", "secret")
		assertFalse(bytesToHex(first.publicKey) == bytesToHex(other.publicKey))
	}

	@Test
	fun `sign and verify stream signatures round trip`() {
		val keyPair = streamKeyPairFromUserSeed("alice", "secret")
		val bytes = streamChunkSignBytes("stream-1", 1.0, listOf(mapOf("a" to 1.0)))
		val signature = signStreamSignatureHex(bytes, keyPair.secretKey)
		assertTrue(verifyStreamSignatureHex(bytes, signature, bytesToHex(keyPair.publicKey)))
		assertFalse(verifyStreamSignatureHex(bytes, signature, "00".repeat(32)))
		assertFalse(verifyStreamSignatureHex(bytes, "nothex", bytesToHex(keyPair.publicKey)))
	}
}
