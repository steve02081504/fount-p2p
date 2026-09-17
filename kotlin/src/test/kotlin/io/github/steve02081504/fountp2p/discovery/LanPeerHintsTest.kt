package io.github.steve02081504.fountp2p.discovery

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 等价 `test/pure/lan_peer_hints.test.mjs`。 */
class LanPeerHintsTest {
	@Test
	fun `lan peer hints store and expire by TTL`() {
		clearLanPeerHints()
		val nodeHash = "ab".repeat(32)
		noteLanPeerHint(nodeHash, LanEndpoint("127.0.0.1", 4242))
		val t0 = System.currentTimeMillis()
		assertEquals("127.0.0.1", getLanPeerHint(nodeHash, t0)?.host)
		assertEquals(4242, getLanPeerHint(nodeHash, t0)?.port)
		noteLanPeerHint("nope", LanEndpoint("", 1))
		assertNull(getLanPeerHint("nope", t0))
		noteLanPeerHint(nodeHash, LanEndpoint("10.0.0.2", 99999))
		assertEquals("127.0.0.1", getLanPeerHint(nodeHash, t0)?.host)
		assertNull(getLanPeerHint(nodeHash, t0 + LAN_PEER_HINT_TTL_MS + 1))
		clearLanPeerHints()
		assertNull(getLanPeerHint(nodeHash, t0))
	}

	@Test
	fun `lan peer hints keep newest observation first`() {
		clearLanPeerHints()
		val nodeHash = "cd".repeat(32)
		noteLanPeerHint(nodeHash, LanEndpoint("10.0.0.1", 1000))
		noteLanPeerHint(nodeHash, LanEndpoint("10.0.0.2", 1000))
		noteLanPeerHint(nodeHash, LanEndpoint("10.0.0.1", 1000))
		assertEquals(
			listOf(LanEndpoint("10.0.0.1", 1000), LanEndpoint("10.0.0.2", 1000)),
			listLanPeerHints(nodeHash),
		)
	}
}
