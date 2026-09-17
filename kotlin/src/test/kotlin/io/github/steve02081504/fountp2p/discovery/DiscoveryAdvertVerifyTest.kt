package io.github.steve02081504.fountp2p.discovery

import io.github.steve02081504.fountp2p.TestIdentity
import io.github.steve02081504.fountp2p.identity
import io.github.steve02081504.fountp2p.discovery.internal.encryptSignalPacket
import io.github.steve02081504.fountp2p.discovery.internal.groupRendezvousKey
import io.github.steve02081504.fountp2p.discovery.internal.networkRendezvousKey
import io.github.steve02081504.fountp2p.discovery.nostr.acceptNostrAdvert
import io.github.steve02081504.fountp2p.discovery.nostr.clearNostrVisibleNodes
import io.github.steve02081504.fountp2p.discovery.nostr.listNostrGroupVisibleNodeHashes
import io.github.steve02081504.fountp2p.discovery.nostr.listNostrVisibleNodeHashes
import io.github.steve02081504.fountp2p.link.buildSignedAdvert
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 等价 `test/pure/discovery_advert_verify.test.mjs`。 */
class DiscoveryAdvertVerifyTest {
	@Test
	fun `acceptNostrAdvert verifies network advert before visible pool`() = runBlocking {
		clearNostrVisibleNodes()
		clearLanPeerHints()
		val local = identity(11)
		val body = buildSignedAdvert(
			networkRendezvousKey(),
			System.currentTimeMillis().toDouble(),
			local.asMap() + mapOf("tcpPort" to 19092, "lanHosts" to listOf("192.168.1.10", "10.0.0.5")),
		)
		val bytes = encryptAdvertForScope("network", local.asMap(), body)
		assertEquals(local.nodeHash, acceptNostrAdvert(networkRendezvousKey(), bytes))
		assertEquals(true, listNostrVisibleNodeHashes().contains(local.nodeHash))
		assertEquals(
			listOf(LanEndpoint("192.168.1.10", 19092), LanEndpoint("10.0.0.5", 19092)),
			listLanPeerHints(local.nodeHash),
		)
		clearNostrVisibleNodes()
		clearLanPeerHints()
	}

	@Test
	fun `acceptNostrAdvert rejects forged network advert`() = runBlocking {
		clearNostrVisibleNodes()
		val fakeHash = "ef".repeat(32)
		val bytes = encryptSignalPacket(
			networkRendezvousKey(),
			mapOf(
				"type" to "advert",
				"body" to mapOf(
					"nodeHash" to fakeHash,
					"nodePubKey" to "ab".repeat(32),
					"ts" to System.currentTimeMillis().toDouble(),
					"sig" to "11".repeat(64),
				),
			),
		)
		assertNull(acceptNostrAdvert(networkRendezvousKey(), bytes))
		assertEquals(false, listNostrVisibleNodeHashes().contains(fakeHash))
		clearNostrVisibleNodes()
	}

	@Test
	fun `acceptNostrAdvert skips self echo into visible pool`() = runBlocking {
		clearNostrVisibleNodes()
		clearLanPeerHints()
		val local = identity(14)
		val body = buildSignedAdvert(
			networkRendezvousKey(),
			System.currentTimeMillis().toDouble(),
			local.asMap() + mapOf("tcpPort" to 19093),
		)
		val bytes = encryptAdvertForScope("network", local.asMap(), body)
		assertEquals(local.nodeHash, acceptNostrAdvert(networkRendezvousKey(), bytes, mapOf("skipNodeHash" to local.nodeHash)))
		assertEquals(false, listNostrVisibleNodeHashes().contains(local.nodeHash))
		assertNull(getLanPeerHint(local.nodeHash))
		clearNostrVisibleNodes()
		clearLanPeerHints()
	}

	@Test
	fun `acceptNostrAdvert verifies group advert into group pool only`() = runBlocking {
		clearNostrVisibleNodes()
		clearLanPeerHints()
		val local = identity(13)
		val roomSecret = "room-verify-1"
		val body = buildSignedAdvertForScope(mapOf("roomSecret" to roomSecret), local.asMap())
		val bytes = encryptAdvertForScope(mapOf("roomSecret" to roomSecret), local.asMap(), body)
		assertEquals(
			local.nodeHash,
			acceptNostrAdvert(groupRendezvousKey(roomSecret), bytes, mapOf("roomSecret" to roomSecret)),
		)
		assertEquals(listOf(local.nodeHash), listNostrGroupVisibleNodeHashes(roomSecret))
		assertEquals(false, listNostrVisibleNodeHashes().contains(local.nodeHash))
		assertNull(getLanPeerHint(local.nodeHash))
		clearNostrVisibleNodes()
		clearLanPeerHints()
	}
}

private fun TestIdentity.asMap(): Map<String, Any?> =
	mapOf("nodeHash" to nodeHash, "nodePubKey" to nodePubKey, "secretKey" to secretKey)
