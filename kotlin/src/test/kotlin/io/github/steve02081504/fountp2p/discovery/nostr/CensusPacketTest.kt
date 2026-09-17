package io.github.steve02081504.fountp2p.discovery.nostr

import io.github.steve02081504.fountp2p.core.base64ToBytes
import io.github.steve02081504.fountp2p.core.bytesToBase64
import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.node.ensureNodeSeed
import io.github.steve02081504.fountp2p.node.getNodeHash
import io.github.steve02081504.fountp2p.node.withTempNode
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 等价 `test/pure/census_packet.test.mjs`。 */
class CensusPacketTest {
	@Test
	fun `census kind is outside advert and signal ranges`() {
		assertEquals(30789, NOSTR_CENSUS_KIND)
	}

	@Test
	fun `build then verify roundtrip succeeds`() = runBlocking {
		withTempNode("census-packet-") {
			val nodeHash = getNodeHash()
			val ts = System.currentTimeMillis()
			val packet = buildCensusPacketFromSeed(ensureNodeSeed(), 0.1, ts)
			assertEquals(nodeHash, packet["nodeHash"])
			val verified = verifyCensusPacket(packet, ts, 10L * 60_000)
			assertEquals(VerifiedCensus(nodeHash, 0.1, ts.toDouble()), verified)
		}
	}

	@Test
	fun `verify rejects tampered payloads`() = runBlocking {
		withTempNode("census-packet-") {
			val ts = System.currentTimeMillis()
			val packet = buildCensusPacketFromSeed(ensureNodeSeed(), 0.1, ts)
			val tamperedP = LinkedHashMap(packet).apply { this["p"] = 0.2 }
			assertNull(verifyCensusPacket(tamperedP, ts))
			val tamperedTs = LinkedHashMap(packet).apply { this["ts"] = (ts + 1).toDouble() }
			assertNull(verifyCensusPacket(tamperedTs, ts))
			val tamperedHash = LinkedHashMap(packet).apply { this["nodeHash"] = "f".repeat(64) }
			assertNull(verifyCensusPacket(tamperedHash, ts))
			val sig = packet["sig"] as String
			val flipped = sig.dropLast(1) + if (sig.endsWith("0")) "1" else "0"
			val tamperedSig = LinkedHashMap(packet).apply { this["sig"] = flipped }
			assertNull(verifyCensusPacket(tamperedSig, ts))
		}
	}

	@Test
	fun `verify rejects invalid shapes and out of window ts`() = runBlocking {
		withTempNode("census-packet-") {
			val ts = System.currentTimeMillis()
			val packet = buildCensusPacketFromSeed(ensureNodeSeed(), 0.1, ts)
			assertNull(verifyCensusPacket(packet, ts + 11L * 60_000, 10L * 60_000))
			assertNull(verifyCensusPacket(LinkedHashMap(packet).apply { this["p"] = 0 }, ts))
			assertNull(verifyCensusPacket(LinkedHashMap(packet).apply { this["p"] = 2 }, ts))
			assertNull(verifyCensusPacket(LinkedHashMap(packet).apply { this["p"] = "x" }, ts))
			assertNull(verifyCensusPacket(LinkedHashMap(packet).apply { this["sig"] = "zz" }, ts))
			assertNull(verifyCensusPacket(LinkedHashMap(packet).apply { this["nodePubKey"] = "nope" }, ts))
			assertNull(verifyCensusPacket(null, ts))
		}
	}

	@Test
	fun `verifyCensusBytes decodes base64 content`() = runBlocking {
		withTempNode("census-packet-") {
			val nodeHash = getNodeHash()
			val ts = System.currentTimeMillis()
			val packet = buildCensusPacketFromSeed(ensureNodeSeed(), 0.1, ts)
			val content = bytesToBase64((Json.stringify(packet) ?: "null").toByteArray(Charsets.UTF_8))
			val verified = verifyCensusBytes(base64ToBytes(content), ts)
			assertEquals(VerifiedCensus(nodeHash, 0.1, ts.toDouble()), verified)
		}
	}

	@Test
	fun `verifyCensusBytes rejects garbage`() {
		assertNull(verifyCensusBytes(byteArrayOf(1, 2, 3)))
		assertNull(verifyCensusBytes("not json".toByteArray(Charsets.UTF_8)))
	}
}
