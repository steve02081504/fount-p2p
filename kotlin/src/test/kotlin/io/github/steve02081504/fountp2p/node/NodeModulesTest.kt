package io.github.steve02081504.fountp2p.node

import io.github.steve02081504.fountp2p.deleteRecursively
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import java.nio.file.Files

/**
 * `node/` 中无独立 JS 纯测试的模块的补充覆盖：
 * signaling_config / storage_plugins / entity_store / routing_profile / instance。
 */
class NodeModulesTest {
	@Test
	fun `default signaling config enables all channels`() {
		val config = defaultSignalingRuntimeConfig()
		@Suppress("UNCHECKED_CAST")
		val channels = config["channels"] as Map<String, Any?>
		// JS 语义：启用但无覆盖的通道值为空对象（object | false）。
		assertEquals(true, channels["nostr"] is Map<*, *>)
		assertEquals(true, channels["lan"] is Map<*, *>)
		assertEquals(true, channels["bt"] is Map<*, *>)
		@Suppress("UNCHECKED_CAST")
		val webrtc = channels["webrtc"] as Map<String, Any?>
		assertEquals(true, webrtc.containsKey("iceLocalHostnamePolicy"))
	}

	@Test
	fun `disableAllChannels keeps explicit overrides`() {
		val channels = disableAllChannels(mapOf("nostr" to true))
		assertEquals(true, channels["nostr"])
		assertEquals(false, channels["lan"])
		assertEquals(false, channels["bt"])
	}

	@Test
	fun `resolveSignalingRuntimeConfig merges channel overrides`() {
		val config = resolveSignalingRuntimeConfig(
			mapOf(
				"channels" to mapOf(
					"bt" to false,
					"webrtc" to mapOf("trickleIceOff" to false),
				),
			),
		)
		@Suppress("UNCHECKED_CAST")
		val channels = config["channels"] as Map<String, Any?>
		assertEquals(false, channels["bt"])
		@Suppress("UNCHECKED_CAST")
		val webrtc = channels["webrtc"] as Map<String, Any?>
		assertEquals(false, webrtc["trickleIceOff"])
		assertEquals(true, webrtc.containsKey("iceLocalHostnamePolicy"))
	}

	@Test
	fun `local storage plugin round trip and invalid locator`() = runBlocking {
		val base = Files.createTempDirectory("p2p-storage-")
		try {
			val plugin = createLocalStoragePlugin(base.toString())
			assertEquals("local", plugin.storagePeerId)
			val chunkHash = "a".repeat(64)
			val stored = plugin.putChunk("g1", chunkHash, byteArrayOf(1, 2, 3))
			assertEquals("local:g1/chunks/$chunkHash.bin", stored.storageLocator)
			assertArrayEquals(byteArrayOf(1, 2, 3), plugin.getChunk(stored.storageLocator))
			plugin.deleteChunk(stored.storageLocator)
			assertEquals(true, runCatching { plugin.getChunk(stored.storageLocator) }.isFailure)
			assertEquals(true, runCatching { plugin.getChunk("blob:not-local") }.isFailure)
		}
		finally {
			deleteRecursively(base)
		}
	}

	@Test
	fun `fs entity store json and file round trip`() = runBlocking {
		val base = Files.createTempDirectory("p2p-entities-")
		try {
			val store = createFsEntityStore(base.toString())
			val entity = "a".repeat(64) + "b".repeat(64)
			store.writeEntityJson(entity, "personal_hide.json", mapOf("hidden" to listOf(mapOf("scope" to "entity", "value" to entity))))
			val read = store.readEntityJson(entity, "personal_hide.json") as Map<*, *>
			assertEquals(1, (read["hidden"] as List<*>).size)

			store.writeEntityFile(entity, "notes/a.txt", byteArrayOf(9))
			store.writeManifest(entity, "notes/a.txt", mapOf("size" to 1.0))
			assertEquals(true, store.statEntityFile(entity, "notes/a.txt"))
			assertEquals(true, store.statManifest(entity, "notes/a.txt"))
			assertArrayEquals(byteArrayOf(9), store.readEntityFile(entity, "notes/a.txt"))
			val manifest = store.readManifest(entity, "notes/a.txt") as Map<*, *>
			assertEquals(1.0, manifest["size"])
			assertEquals(listOf("notes/a.txt"), store.listEntityFiles(entity))
			assertEquals(listOf(entity), store.listEntityHashes())

			assertEquals(true, runCatching { store.readManifest(entity, "../evil") }.isFailure)
		}
		finally {
			deleteRecursively(base)
		}
	}

	@Test
	fun `routing profile round trip`() = runBlocking {
		withTempNode("fount-routing-") {
			assertEquals("default", getRoutingProfile())
			assertEquals("low", setRoutingProfile("low"))
			assertEquals("low", getRoutingProfile())
			assertEquals("default", setRoutingProfile("default"))
			assertEquals(true, runCatching { setRoutingProfile("turbo") }.isFailure)
		}
	}

	@Test
	fun `instance lifecycle and feature flags`() = runBlocking {
		val dir = Files.createTempDirectory("fount-instance-")
		try {
			closeNode()
			assertEquals(false, isNodeInitialized())
			initNode(NodeInitOptions(nodeDir = dir.toString()))
			assertEquals(true, isNodeInitialized())
			assertEquals(dir.toString(), getNodeDir())
			assertEquals(mapOf<String, Any?>("census" to true), getP2PFeatures())
			setP2PFeatures(mapOf("census" to false))
			assertEquals(false, getP2PFeatures()["census"])
			assertEquals(true, runCatching { initNode(NodeInitOptions(nodeDir = dir.toString())) }.isFailure)
			assertEquals(true, runCatching { initNode(NodeInitOptions(nodeDir = dir.toString(), logger = ConsoleNodeLogger)) }.isFailure)
		}
		finally {
			closeNode()
			deleteRecursively(dir)
		}
	}
}
