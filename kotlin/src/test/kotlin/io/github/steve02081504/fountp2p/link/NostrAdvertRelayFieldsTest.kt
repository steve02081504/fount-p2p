package io.github.steve02081504.fountp2p.link

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.hexToBytes
import io.github.steve02081504.fountp2p.discovery.nostr.MAX_ADVERT_LISTEN_RELAYS
import io.github.steve02081504.fountp2p.discovery.nostr.MAX_ADVERT_RELAY_POOL
import io.github.steve02081504.fountp2p.discovery.nostr.MAX_RTT_MS
import io.github.steve02081504.fountp2p.identity
import io.github.steve02081504.fountp2p.node.NodeLogger
import io.github.steve02081504.fountp2p.node.setConnectivityDebug
import io.github.steve02081504.fountp2p.node.setNodeLogger
import io.github.steve02081504.fountp2p.node.withTempNode
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 等价 `test/pure/nostr_advert_relay_fields.test.mjs`。 */
class NostrAdvertRelayFieldsTest {
	private val rendezvous = "rdv:test"

	@Test
	fun `buildSignedAdvert carries sanitized pool and listen and verifies roundtrip`() {
		val local = identity(21)
		val pool = listOf(
			mapOf("url" to "wss://pool-a.example.com", "rttMs" to 42),
			mapOf("url" to "wss://pool-b.example.com", "rttMs" to 55),
		)
		val listen = listOf("wss://listen-a.example.com", "wss://listen-b.example.com")
		val advert = buildSignedAdvert(
			rendezvous,
			1234.0,
			mapOf(
				"secretKey" to local.secretKey,
				"nodeHash" to local.nodeHash,
				"nodePubKey" to local.nodePubKey,
				"nostrRelayPool" to pool,
				"listenNostrRelays" to listen,
			),
		)
		assertEquals(
			listOf(
				mapOf("url" to "wss://pool-a.example.com", "rtt" to 42.0),
				mapOf("url" to "wss://pool-b.example.com", "rtt" to 55.0),
			),
			advert["nostrRelayPool"],
		)
		assertEquals(listen, advert["listenNostrRelays"])
		val verified = verifySignedAdvert(rendezvous, advert, 1234L)
		assertEquals(local.nodeHash, verified?.nodeHash)
		assertEquals(
			listOf(
				mapOf("url" to "wss://pool-a.example.com", "rtt" to 42.0),
				mapOf("url" to "wss://pool-b.example.com", "rtt" to 55.0),
			),
			verified?.relayPool,
		)
		assertEquals(listen, verified?.listenRelays)
	}

	@Test
	fun `tampering with pool or listen invalidates signature`() {
		val local = identity(22)
		val advert = buildSignedAdvert(
			rendezvous,
			1234.0,
			mapOf(
				"secretKey" to local.secretKey,
				"nodeHash" to local.nodeHash,
				"nodePubKey" to local.nodePubKey,
				"nostrRelayPool" to listOf(mapOf("url" to "wss://pool.example.com", "rttMs" to 42)),
				"listenNostrRelays" to listOf("wss://listen.example.com"),
			),
		)
		val tamperedPool = LinkedHashMap(advert)
		tamperedPool["nostrRelayPool"] = listOf(mapOf("url" to "wss://evil.example.com", "rttMs" to 42))
		assertNull(verifySignedAdvert(rendezvous, tamperedPool, 1234L))
		val tamperedListen = LinkedHashMap(advert)
		tamperedListen["listenNostrRelays"] = listOf("wss://evil.example.com")
		assertNull(verifySignedAdvert(rendezvous, tamperedListen, 1234L))
		assertEquals(local.nodeHash, verifySignedAdvert(rendezvous, advert, 1234L)?.nodeHash)
	}

	@Test
	fun `sanitizeAdvertRelayFields trims invalid entries and caps sizes`() {
		val pool = listOf(
			mapOf("url" to "http://bad.example.com", "rttMs" to 10),
			mapOf("url" to "wss://ok.example.com", "rttMs" to 10),
			mapOf("url" to "wss://dup.example.com", "rttMs" to 10),
			mapOf("url" to "wss://dup.example.com", "rttMs" to 20),
			mapOf("url" to "wss://highrtt.example.com", "rttMs" to MAX_RTT_MS + 1),
		)
		val listen = listOf("ws://public.example.com", "wss://good.example.com", "wss://good.example.com")
		val result = sanitizeAdvertRelayFields(pool, listen)
		assertEquals(2, result.pool.size)
		assertEquals(mapOf("url" to "wss://ok.example.com", "rtt" to 10.0), result.pool[0])
		assertEquals(1, result.listen.size)
		assertEquals("wss://good.example.com", result.listen[0])
	}

	@Test
	fun `sanitize caps pool and listen to limits`() {
		val pool = (0 until MAX_ADVERT_RELAY_POOL + 10).map { mapOf("url" to "wss://p$it.example.com", "rttMs" to 10) }
		val listen = (0 until MAX_ADVERT_LISTEN_RELAYS + 10).map { "wss://l$it.example.com" }
		val result = sanitizeAdvertRelayFields(pool, listen)
		assertEquals(MAX_ADVERT_RELAY_POOL, result.pool.size)
		assertEquals(MAX_ADVERT_LISTEN_RELAYS, result.listen.size)
	}

	@Test
	fun `sanitize emits audit log for dropped entries`() = runBlocking {
		withTempNode("fount-p2p-advert-") {
			val messages = ArrayList<String>()
			val logger = object : NodeLogger {
				override fun info(vararg args: Any?) {
					messages.add(args.joinToString(" ") { it?.toString() ?: "null" })
				}
			}
			setNodeLogger(logger)
			setConnectivityDebug(true)
			try {
				val result = sanitizeAdvertRelayFields(
					listOf(
						mapOf("url" to "http://bad.example.com", "rttMs" to 10),
						mapOf("url" to "wss://badrtt.example.com", "rttMs" to 999999),
					),
					listOf("ws://public.example.com"),
				)
				assertEquals(0, result.pool.size)
				assertEquals(0, result.listen.size)
				val dropped = messages.filter { it.contains("invalidRelayUrl") }
				assertTrue("expected audit entries, got ${dropped.size}", dropped.size >= 3)
			}
			finally {
				setConnectivityDebug(false)
				setNodeLogger(null)
			}
		}
	}

	@Test
	fun `canonicalAdvertRelayBlob sorts deterministically and round trips`() {
		val blobA = canonicalAdvertRelayBlob(
			listOf(
				mapOf("url" to "wss://b.example.com", "rtt" to 1.0),
				mapOf("url" to "wss://a.example.com", "rtt" to 2.0),
			),
			listOf("wss://z.example.com", "wss://a.example.com"),
		)
		val blobB = canonicalAdvertRelayBlob(
			listOf(
				mapOf("url" to "wss://a.example.com", "rtt" to 2.0),
				mapOf("url" to "wss://b.example.com", "rtt" to 1.0),
			),
			listOf("wss://a.example.com", "wss://z.example.com"),
		)
		assertEquals(blobA, blobB)
		assertTrue(blobA.isNotEmpty())
		val parsed = Json.parse(String(hexToBytes(blobA), Charsets.UTF_8)) as Map<*, *>
		assertEquals("wss://a.example.com", (parsed["l"] as List<*>)[0])
	}
}
