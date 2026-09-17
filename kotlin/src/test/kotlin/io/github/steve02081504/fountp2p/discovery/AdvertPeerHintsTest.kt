package io.github.steve02081504.fountp2p.discovery

import io.github.steve02081504.fountp2p.discovery.bt.clearBtPeerHints
import io.github.steve02081504.fountp2p.discovery.bt.getBtPeerHint
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 等价 `test/pure/advert_peer_hints.test.mjs`。 */
class AdvertPeerHintsTest {
	private val nodeHash = "a".repeat(64)

	@Test
	fun `noteAdvertPeerHints records LAN and BT from advert body plus meta`() {
		clearLanPeerHints()
		clearBtPeerHints()
		noteAdvertPeerHints(
			nodeHash,
			mapOf("tcpPort" to 18080),
			mapOf("address" to "10.0.0.5", "peripheralId" to "aa:bb:cc:dd:ee:ff"),
		)
		val lan = getLanPeerHint(nodeHash)
		assertEquals("10.0.0.5", lan?.host)
		assertEquals(18080, lan?.port)
		assertEquals("aa:bb:cc:dd:ee:ff", getBtPeerHint(nodeHash)?.peripheralId)
	}

	@Test
	fun `noteAdvertPeerHints records LAN hints from signed lanHosts when meta has no address`() {
		clearLanPeerHints()
		clearBtPeerHints()
		noteAdvertPeerHints(nodeHash, mapOf("tcpPort" to 18080, "lanHosts" to listOf("192.168.1.10", "10.0.0.5")), emptyMap())
		assertEquals(
			listOf(LanEndpoint("192.168.1.10", 18080), LanEndpoint("10.0.0.5", 18080)),
			listLanPeerHints(nodeHash),
		)
	}

	@Test
	fun `noteAdvertPeerHints prefers meta address over body lanHosts`() {
		clearLanPeerHints()
		clearBtPeerHints()
		noteAdvertPeerHints(
			nodeHash,
			mapOf("tcpPort" to 18080, "lanHosts" to listOf("192.168.1.10", "10.0.0.5")),
			mapOf("address" to "10.0.0.9"),
		)
		assertEquals(
			listOf(LanEndpoint("10.0.0.9", 18080), LanEndpoint("192.168.1.10", 18080), LanEndpoint("10.0.0.5", 18080)),
			listLanPeerHints(nodeHash),
		)
	}

	@Test
	fun `noteAdvertPeerHints ignores incomplete LAN endpoint`() {
		clearLanPeerHints()
		clearBtPeerHints()
		noteAdvertPeerHints(nodeHash, mapOf("tcpPort" to 18080), mapOf("address" to ""))
		assertNull(getLanPeerHint(nodeHash))
		noteAdvertPeerHints(nodeHash, emptyMap(), mapOf("address" to "10.0.0.5"))
		assertNull(getLanPeerHint(nodeHash))
		noteAdvertPeerHints(nodeHash, mapOf("tcpPort" to 99999), mapOf("address" to "10.0.0.5"))
		assertNull(getLanPeerHint(nodeHash))
	}
}
