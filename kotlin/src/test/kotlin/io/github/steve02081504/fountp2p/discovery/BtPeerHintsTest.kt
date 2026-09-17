package io.github.steve02081504.fountp2p.discovery

import io.github.steve02081504.fountp2p.identity
import io.github.steve02081504.fountp2p.discovery.bt.BT_PEER_HINT_TTL_MS
import io.github.steve02081504.fountp2p.discovery.bt.acceptBtScannedPresence
import io.github.steve02081504.fountp2p.discovery.bt.clearBtPeerHints
import io.github.steve02081504.fountp2p.discovery.bt.clearBtVisibleNodes
import io.github.steve02081504.fountp2p.discovery.bt.createBluetoothDiscoveryProvider
import io.github.steve02081504.fountp2p.discovery.bt.getBtPeerHint
import io.github.steve02081504.fountp2p.discovery.bt.listBtVisibleNodeHashes
import io.github.steve02081504.fountp2p.discovery.bt.noteBtPeerHint
import io.github.steve02081504.fountp2p.discovery.internal.encryptSignalPacket
import io.github.steve02081504.fountp2p.discovery.internal.networkRendezvousKey
import io.github.steve02081504.fountp2p.link.providers.createBleGattLinkProvider
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 等价 `test/pure/bt_peer_hints.test.mjs`。 */
class BtPeerHintsTest {
	@Test
	fun `bt peer hints store and expire by TTL`() {
		clearBtPeerHints()
		val nodeHash = "cd".repeat(32)
		noteBtPeerHint(nodeHash, "aa:bb:cc:dd:ee:ff")
		val t0 = System.currentTimeMillis()
		assertEquals("aa:bb:cc:dd:ee:ff", getBtPeerHint(nodeHash, t0)?.peripheralId)
		noteBtPeerHint("nope", "")
		assertNull(getBtPeerHint("nope", t0))
		assertNull(getBtPeerHint(nodeHash, t0 + BT_PEER_HINT_TTL_MS + 1))
		clearBtPeerHints()
		assertNull(getBtPeerHint(nodeHash, t0))
	}

	@Test
	fun `ble_gatt canReach follows bt peer hint`() {
		clearBtPeerHints()
		val nodeHash = "ef".repeat(32)
		val provider = createBleGattLinkProvider()
		assertEquals(false, provider.canReach(mapOf("nodeHash" to nodeHash)))
		noteBtPeerHint(nodeHash, "11:22:33:44:55:66")
		assertEquals(true, provider.canReach(mapOf("nodeHash" to nodeHash)))
		clearBtPeerHints()
		assertEquals(false, provider.canReach(mapOf("nodeHash" to nodeHash)))
	}

	@Test
	fun `bt connectToNode returns false without peer hint`() = runBlocking {
		clearBtPeerHints()
		val nodeHash = "ab".repeat(32)
		val bt = createBluetoothDiscoveryProvider()
		assertEquals(false, bt.connectToNode(nodeHash))
	}

	@Test
	fun `acceptBtScannedPresence verifies advert and records peripheral hint`() {
		clearBtPeerHints()
		clearBtVisibleNodes()
		val local = identity(7)
		val body = buildSignedAdvertForScope("network", local.asMap())
		val bytes = encryptAdvertForScope("network", local.asMap(), body)
		val peripheralId = "scan-peripheral-01"
		val ingested = acceptBtScannedPresence(bytes, mapOf("peripheralId" to peripheralId))
		assertEquals(local.nodeHash, ingested?.get("verifiedNodeHash"))
		assertEquals(peripheralId, getBtPeerHint(local.nodeHash)?.peripheralId)
		assertEquals(true, listBtVisibleNodeHashes().contains(local.nodeHash))
		clearBtPeerHints()
		clearBtVisibleNodes()
	}

	@Test
	fun `acceptBtScannedPresence rejects forged nodeHash without valid signature`() {
		clearBtPeerHints()
		clearBtVisibleNodes()
		val fakeHash = "cd".repeat(32)
		val bytes = encryptSignalPacket(
			networkRendezvousKey(),
			mapOf(
				"type" to "advert",
				"body" to mapOf(
					"nodeHash" to fakeHash,
					"nodePubKey" to "ab".repeat(32),
					"ts" to System.currentTimeMillis().toDouble(),
					"sig" to "00".repeat(64),
				),
			),
		)
		assertNull(acceptBtScannedPresence(bytes, mapOf("peripheralId" to "x")))
		assertNull(getBtPeerHint(fakeHash))
		assertEquals(false, listBtVisibleNodeHashes().contains(fakeHash))
		clearBtPeerHints()
		clearBtVisibleNodes()
	}
}

private fun io.github.steve02081504.fountp2p.TestIdentity.asMap(): Map<String, Any?> =
	mapOf("nodeHash" to nodeHash, "nodePubKey" to nodePubKey, "secretKey" to secretKey)
