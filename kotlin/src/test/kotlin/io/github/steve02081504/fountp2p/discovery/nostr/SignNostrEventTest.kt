package io.github.steve02081504.fountp2p.discovery.nostr

import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.core.hexToBytes
import io.github.steve02081504.fountp2p.crypto.schnorrVerify
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `signNostrEvent` 等价测试。
 *
 * 期望值由 JS 侧（`@noble/curves/secp256k1` + `JSON.stringify` + `sha256`）生成，
 * 保证事件 id / pubkey / sig 与 JS 逐字节一致。
 */
class SignNostrEventTest {
	private val secretKey = hexToBytes("11".repeat(32))
	private val auxRand = hexToBytes("22".repeat(32))
	private val tags = listOf(listOf("t", "fount"), listOf("t", "rk"), listOf("x", "advert"), listOf("d", "rk"))

	@Test
	fun `signNostrEvent matches JS noble generated event`() {
		val event = signNostrEvent(
			kind = 30787,
			tags = tags,
			content = "aGVsbG8=",
			secretKey = secretKey,
			createdAt = 1700000000,
			auxRand = auxRand,
		)

		assertEquals(
			listOf("id", "pubkey", "created_at", "kind", "tags", "content", "sig"),
			event.keys.toList(),
		)
		assertEquals("4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa", event["pubkey"])
		assertEquals("f860d7aac582fce51f8429f1153b309b8ebffc0a56a193ddbf35d628e4a9edbe", event["id"])
		assertEquals(
			"49febe20b4472378479991193cb886d1f3743b085914b8edd00bed5625dd859c8b4020990afa434353bf6f6d993d9c70ad7fb95e2a868f007c4262f8112dfa89",
			event["sig"],
		)
		assertEquals(30787.0, event["kind"])
		assertEquals(1700000000.0, event["created_at"])
		assertEquals(tags, event["tags"])
		assertEquals("aGVsbG8=", event["content"])
	}

	@Test
	fun `signNostrEvent signature verifies against its own id and pubkey`() {
		val event = signNostrEvent(20787, tags, "payload", secretKey, createdAt = 1700000001, auxRand = auxRand)
		val id = event["id"] as String
		val pubkey = event["pubkey"] as String
		val sig = event["sig"] as String
		assertTrue(schnorrVerify(hexToBytes(id), hexToBytes(sig), hexToBytes(pubkey)))
	}

	@Test
	fun `signNostrEvent uses fresh aux rand by default and still verifies`() {
		val first = signNostrEvent(20787, tags, "payload", secretKey, createdAt = 1700000002)
		val second = signNostrEvent(20787, tags, "payload", secretKey, createdAt = 1700000002)
		assertEquals(first["id"], second["id"])
		for (event in listOf(first, second))
			assertTrue(
				schnorrVerify(
					hexToBytes(event["id"] as String),
					hexToBytes(event["sig"] as String),
					hexToBytes(event["pubkey"] as String),
				),
			)
		assertTrue(bytesToHex(hexToBytes(first["sig"] as String)).isNotEmpty())
	}
}
