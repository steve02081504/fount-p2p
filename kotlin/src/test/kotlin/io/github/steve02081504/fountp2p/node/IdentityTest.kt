package io.github.steve02081504.fountp2p.node

import io.github.steve02081504.fountp2p.core.hashFromPubKeyHex
import io.github.steve02081504.fountp2p.core.isHex64
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * `node/identity.mjs` 的覆盖。
 *
 * `test/pure/evfs_manifest.test.mjs` 的 `nodeHashFromSeed is stable` 与
 * `test/pure/census_packet.test.mjs` / `public_manifest.test.mjs` 对
 * `ensureNodeSeed` / `getNodeHash` 的使用在此合并覆盖。
 *
 * 备注：`test/fount/entity_key_auth_social.test.mjs` 依赖 Deno + fount social bridge
 * （`federation/entity_key_auth.mjs`），其可移植的 rotate / isActiveSender 部分已由
 * `federation/EntityKeyChainTest.kt` 覆盖；`social_meta` 折叠 recoveryPubKeyHex 与
 * `isEntityTimelineWriteAuthorized` 未在本仓库 Kotlin 侧实现，故不重复移植。
 */
class IdentityTest {
	@Test
	fun `nodeHashFromSeed is stable`() {
		val seed = "a".repeat(64)
		assertEquals(nodeHashFromSeed(seed), nodeHashFromSeed(seed))
		assertEquals(true, nodeHashFromSeed(seed) != nodeHashFromSeed("b".repeat(64)))
		assertEquals(true, runCatching { nodeHashFromSeed("ab") }.isFailure)
	}

	@Test
	fun `ensureNodeSeed persists and getNodeHash derives from it`() = runBlocking {
		withTempNode("fount-identity-") {
			val seed = ensureNodeSeed()
			assertEquals(64, seed.length)
			assertEquals(seed, isHex64(seed))
			assertEquals(seed, ensureNodeSeed())
			assertEquals(nodeHashFromSeed(seed), getNodeHash())
			assertEquals(64, getNodeHash().length)
		}
	}

	@Test
	fun `entityHashFromKeys and local writable checks`() = runBlocking {
		withTempNode("fount-identity-") {
			val recovery = "a".repeat(64)
			val node = getNodeHash()
			val entityHash = entityHashFromKeys(node, recovery)
			assertEquals(node + hashFromPubKeyHex(recovery), entityHash)
			assertEquals(entityHash, resolveLocalEntityHashFromRecoveryPubKeyHex(recovery))
			assertNull(entityHashFromKeys("zz", recovery))
			assertNull(entityHashFromKeys(node, "nothex"))
			assertNull(resolveLocalEntityHashFromRecoveryPubKeyHex("nothex"))
			assertEquals(true, isWritableLocalEntity(entityHash))
			assertEquals(false, isWritableLocalEntity("a".repeat(128)))
			assertEquals(false, isWritableLocalEntity("short"))
		}
	}

	@Test
	fun `transport settings filter relay urls and round trip battery saver`() = runBlocking {
		withTempNode("fount-identity-") {
			val before = getNodeTransportSettings()
			assertEquals(emptyList<String>(), before["relayUrls"])
			assertEquals(false, before["batterySaver"])

			saveNodeTransportSettings(
				mapOf("relayUrls" to listOf("wss://a", "http://b", "wss://c")),
			)
			val after = getNodeTransportSettings()
			assertEquals(listOf("wss://a", "wss://c"), after["relayUrls"])
			assertEquals(false, after["batterySaver"])

			saveNodeTransportSettings(mapOf("batterySaver" to true))
			assertEquals(true, getNodeTransportSettings()["batterySaver"])
			assertEquals("low", getRoutingProfile())
		}
	}

	@Test
	fun `ensureNodeDefaults fills mailbox and nodeHash`() = runBlocking {
		withTempNode("fount-identity-") {
			val defaults = ensureNodeDefaults()
			assertEquals(getNodeHash(), defaults["nodeHash"])
			@Suppress("UNCHECKED_CAST")
			val mailbox = defaults["mailbox"] as Map<String, Any?>
			assertEquals(3.0, mailbox["maxHop"])
			assertEquals(3.0, mailbox["relayFanoutTrusted"])
			assertEquals(3.0, mailbox["wantFanout"])
			assertEquals(emptyList<String>(), defaults["relayUrls"])
		}
	}
}
