package io.github.steve02081504.fountp2p.crypto

import io.github.steve02081504.fountp2p.core.bytesToHex
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 等价 `test/pure/channel_crypto.test.mjs`。 */
class ChannelCryptoTest {
	@Test
	fun `channel key HPKE wrap roundtrip`() {
		val seed = randomBytes(32)
		val pubHex = bytesToHex(publicKeyFromSeed(seed))
		val kch = generateChannelKey()
		val wrap = wrapKeyEcies(kch, pubHex)
		assertEquals(kch, unwrapKeyEcies(wrap, seed))
	}

	@Test
	fun `channel-key message encrypt decrypt`() {
		val kch = generateChannelKey()
		val channelId = "general"
		val gen = 2
		val plain = """{"type":"text","content":"hello"}"""
		val envelope = encryptWithChannelKey(plain, kch, channelId, gen)
		assertEquals(CHANNEL_KEY_SCHEME, envelope["scheme"])
		assertEquals("channel-key", CHANNEL_KEY_SCHEME)

		val payload = envelope["payload"] as String
		assertEquals(3, payload.split(".").size)
		assertEquals(plain, decryptWithChannelKey(envelope, kch, channelId))
	}

	@Test
	fun `prior key generation still decrypts after rotate`() {
		val k0 = generateChannelKey()
		val k1 = generateChannelKey()
		val channelId = "ch1"
		val e0 = encryptWithChannelKey("before-rotate", k0, channelId, 0)
		val e1 = encryptWithChannelKey("after-rotate", k1, channelId, 1)
		assertEquals("before-rotate", decryptWithChannelKey(e0, k0, channelId))
		assertEquals("after-rotate", decryptWithChannelKey(e1, k1, channelId))
		assertNull(decryptWithChannelKey(e0, k1, channelId))
	}
}
