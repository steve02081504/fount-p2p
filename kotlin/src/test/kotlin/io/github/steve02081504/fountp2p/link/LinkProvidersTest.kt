package io.github.steve02081504.fountp2p.link

import io.github.steve02081504.fountp2p.crypto.keyPairFromSeed
import io.github.steve02081504.fountp2p.crypto.pubKeyHash
import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.link.providers.LINK_LEVEL_BLE_GATT
import io.github.steve02081504.fountp2p.link.providers.LINK_LEVEL_WEBRTC
import io.github.steve02081504.fountp2p.link.providers.LinkHandle
import io.github.steve02081504.fountp2p.link.providers.LinkProvider
import io.github.steve02081504.fountp2p.link.providers.clearLinkProviders
import io.github.steve02081504.fountp2p.link.providers.listAvailableLinkProviders
import io.github.steve02081504.fountp2p.link.providers.listLinkProviders
import io.github.steve02081504.fountp2p.link.providers.registerLinkProvider
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 等价 `test/pure/link_providers.test.mjs`。 */
class LinkProvidersTest {
	private class StubProvider(
		override val id: String,
		override val level: Double,
		private val available: suspend () -> Boolean,
	) : LinkProvider {
		override suspend fun isAvailable(): Boolean = available()

		override suspend fun dial(options: Map<String, Any?>): LinkHandle? = throw IllegalStateException("unused")
	}

	@Test
	fun `listLinkProviders sorts by level descending`() {
		clearLinkProviders()
		registerLinkProvider(StubProvider("low", LINK_LEVEL_BLE_GATT) { true })
		registerLinkProvider(StubProvider("high", LINK_LEVEL_WEBRTC) { true })
		assertEquals(listOf("high", "low"), listLinkProviders().map { it.id })
		clearLinkProviders()
	}

	@Test
	fun `listAvailableLinkProviders skips unavailable`() = runBlocking {
		clearLinkProviders()
		registerLinkProvider(StubProvider("up", 50.0) { true })
		registerLinkProvider(StubProvider("down", 90.0) { false })
		registerLinkProvider(StubProvider("boom", 80.0) { throw IllegalStateException("probe fail") })
		assertEquals(listOf("up"), listAvailableLinkProviders().map { it.id })
		clearLinkProviders()
	}

	@Test
	fun `normalizeLinkBinding accepts DTLS fingerprint and hex64 linkId`() {
		val fingerprint =
			"aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99"
		assertEquals(fingerprint, normalizeLinkBinding(fingerprint))
		val linkId = "ab".repeat(32)
		assertEquals(linkId, normalizeLinkBinding(linkId))
		assertNull(normalizeLinkBinding("not-a-binding"))
	}

	@Test
	fun `verifyAuth accepts hex64 linkId binding`() {
		val keyPair = keyPairFromSeed(ByteArray(32) { 3 })
		val nodeHash = pubKeyHash(keyPair.publicKey)
		val linkId = "cd".repeat(32)
		val hello = buildHello(
			mapOf(
				"nodeHash" to nodeHash,
				"nodePubKey" to bytesToHex(keyPair.publicKey),
				"nonce" to "44".repeat(32),
			),
		)
		val auth = buildAuth(hello["nonce"] as String, linkId, mapOf("secretKey" to keyPair.secretKey, "nodeHash" to nodeHash))
		assertEquals(nodeHash, verifyAuth(hello, auth, hello["nonce"] as String, linkId))
		assertNull(verifyAuth(hello, auth, hello["nonce"] as String, "ee".repeat(32)))
	}
}
