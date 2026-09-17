package io.github.steve02081504.fountp2p.link

import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.crypto.keyPairFromSeed
import io.github.steve02081504.fountp2p.crypto.pubKeyHash
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 等价 `test/pure/link_handshake.test.mjs`。 */
class HandshakeTest {
	private val fingerprint =
		"aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99"

	@Test
	fun `verifyAuth accepts a valid hello auth pair`() {
		val seed = ByteArray(32) { 7 }
		val keyPair = keyPairFromSeed(seed)
		val nodeHash = pubKeyHash(keyPair.publicKey)
		val hello = buildHello(
			mapOf(
				"nodeHash" to nodeHash,
				"nodePubKey" to bytesToHex(keyPair.publicKey),
				"nonce" to "11".repeat(32),
			),
		)
		val auth = buildAuth(hello["nonce"] as String, fingerprint, mapOf("secretKey" to keyPair.secretKey, "nodeHash" to nodeHash))
		assertEquals(nodeHash, verifyAuth(hello, auth, hello["nonce"] as String, fingerprint))
	}

	@Test
	fun `verifyAuth rejects fingerprint mismatch`() {
		val seed = ByteArray(32) { 8 }
		val keyPair = keyPairFromSeed(seed)
		val nodeHash = pubKeyHash(keyPair.publicKey)
		val hello = buildHello(
			mapOf(
				"nodeHash" to nodeHash,
				"nodePubKey" to bytesToHex(keyPair.publicKey),
				"nonce" to "22".repeat(32),
			),
		)
		val auth = buildAuth(hello["nonce"] as String, fingerprint, mapOf("secretKey" to keyPair.secretKey, "nodeHash" to nodeHash))
		assertNull(verifyAuth(hello, auth, hello["nonce"] as String, fingerprint.replace("aa", "ff")))
	}

	@Test
	fun `parseHello rejects spoofed pubkey hash`() {
		val seed = ByteArray(32) { 9 }
		val keyPair = keyPairFromSeed(seed)
		assertNull(
			parseHello(
				mapOf(
					"nodeHash" to "ff".repeat(32),
					"nodePubKey" to bytesToHex(keyPair.publicKey),
					"nonce" to "33".repeat(32),
				),
			),
		)
	}

	@Test
	fun `advert signatures verify against rendezvousKey and timestamp`() {
		val seed = ByteArray(32) { 5 }
		val keyPair = keyPairFromSeed(seed)
		val nodeHash = pubKeyHash(keyPair.publicKey)
		val rendezvousKey = "rdv:$nodeHash"
		val advert = buildSignedAdvert(
			rendezvousKey,
			1234.0,
			mapOf("secretKey" to keyPair.secretKey, "nodeHash" to nodeHash, "nodePubKey" to bytesToHex(keyPair.publicKey)),
		)
		assertEquals(nodeHash, verifySignedAdvert(rendezvousKey, advert, 1234L)?.nodeHash)
	}

	@Test
	fun `advert with tcpPort signs port into the message`() {
		val seed = ByteArray(32) { 6 }
		val keyPair = keyPairFromSeed(seed)
		val nodeHash = pubKeyHash(keyPair.publicKey)
		val rendezvousKey = "rdv:$nodeHash"
		val advert = buildSignedAdvert(
			rendezvousKey,
			1234.0,
			mapOf(
				"secretKey" to keyPair.secretKey,
				"nodeHash" to nodeHash,
				"nodePubKey" to bytesToHex(keyPair.publicKey),
				"tcpPort" to 18080,
			),
		)
		assertEquals(18080.0, advert["tcpPort"])
		assertEquals(nodeHash, verifySignedAdvert(rendezvousKey, advert, 1234L)?.nodeHash)
		val tampered = LinkedHashMap(advert)
		tampered["tcpPort"] = 18081.0
		assertNull(verifySignedAdvert(rendezvousKey, tampered, 1234L))
		val withoutPort = LinkedHashMap(advert)
		withoutPort.remove("tcpPort")
		assertNull(verifySignedAdvert(rendezvousKey, withoutPort, 1234L))
	}

	@Test
	fun `advert with lanHosts signs hosts into the message`() {
		val seed = ByteArray(32) { 7 }
		val keyPair = keyPairFromSeed(seed)
		val nodeHash = pubKeyHash(keyPair.publicKey)
		val rendezvousKey = "rdv:$nodeHash"
		val advert = buildSignedAdvert(
			rendezvousKey,
			1234.0,
			mapOf(
				"secretKey" to keyPair.secretKey,
				"nodeHash" to nodeHash,
				"nodePubKey" to bytesToHex(keyPair.publicKey),
				"tcpPort" to 18080,
				"lanHosts" to listOf("192.168.1.10", "10.0.0.5"),
			),
		)
		assertEquals(listOf("192.168.1.10", "10.0.0.5"), advert["lanHosts"])
		assertEquals(nodeHash, verifySignedAdvert(rendezvousKey, advert, 1234L)?.nodeHash)
		val tampered = LinkedHashMap(advert)
		tampered["lanHosts"] = listOf("10.0.0.5")
		assertNull(verifySignedAdvert(rendezvousKey, tampered, 1234L))
	}
}
