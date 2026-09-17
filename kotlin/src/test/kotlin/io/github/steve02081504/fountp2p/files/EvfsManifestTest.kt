package io.github.steve02081504.fountp2p.files

import io.github.steve02081504.fountp2p.core.FEDERATION_CHUNK_MAX_BYTES
import io.github.steve02081504.fountp2p.core.assertSafeEvfsLogicalPath
import io.github.steve02081504.fountp2p.core.isLogicalEntityHash
import io.github.steve02081504.fountp2p.core.logicalEntityHash
import io.github.steve02081504.fountp2p.core.LOGICAL_ENTITY_SENTINEL_NODE_HASH
import io.github.steve02081504.fountp2p.files.manifest.canReadManifest
import io.github.steve02081504.fountp2p.files.manifest.canWriteManifestPath
import io.github.steve02081504.fountp2p.files.manifest.normalizeFileManifest
import io.github.steve02081504.fountp2p.files.manifest.registerManifestAcl
import io.github.steve02081504.fountp2p.files.manifest.registerManifestOwner
import io.github.steve02081504.fountp2p.files.manifest.unregisterManifestAcl
import io.github.steve02081504.fountp2p.files.manifest.unregisterManifestOwner
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

/** 等价 `js/test/pure/evfs_manifest.test.mjs`。 */
class EvfsManifestTest {
	private val testEntity = "a".repeat(64) + "b".repeat(64)
	private val testGroup = "test-group-uuid"
	private val testGroupSubject = "fount:chat:group:$testGroup"

	@Test
	fun `logicalEntityHash uses sentinel node`() {
		val entityHash = logicalEntityHash(testGroupSubject)
		assertEquals(LOGICAL_ENTITY_SENTINEL_NODE_HASH, entityHash.substring(0, 64))
		assertEquals(true, isLogicalEntityHash(entityHash))
	}

	@Test
	fun `convergent encrypt-decrypt roundtrip via manifest`() = runBlocking {
		val plain = "hello evfs".toByteArray(Charsets.UTF_8)
		val enc = encryptPlaintextToParts(plain, "convergent")
		val manifest = buildFileManifest(
			mapOf(
				"ownerEntityHash" to testEntity,
				"logicalPath" to "shells/chat/attachments/test",
				"plaintext" to plain,
				"mimeType" to "text/plain",
				"ceMode" to "convergent",
			),
		)
		val assembled = assembleManifestPlaintext(manifest, enc.parts.map { it["raw"] as ByteArray })
		assertEquals("hello evfs", assembled?.toString(Charsets.UTF_8))
	}

	@Test
	fun `multipart convergent roundtrip keeps per-part contentHash`() = runBlocking {
		val plain = ByteArray(FEDERATION_CHUNK_MAX_BYTES.toInt() + 1000) { 0x42 }
		val enc = encryptPlaintextToMultiParts(plain, "convergent")
		assertEquals(true, enc.parts.size > 1)
		assertEquals(true, enc.parts[0]["contentHash"] != null)
		val manifest = normalizeFileManifest(
			mapOf(
				"ownerEntityHash" to testEntity,
				"logicalPath" to "shells/chat/attachments/big",
				"name" to "big.bin",
				"mimeType" to "application/octet-stream",
				"size" to plain.size.toDouble(),
				"contentHash" to enc.contentHash,
				"ceMode" to "convergent",
				"parts" to enc.parts.map { mapOf("hash" to it["hash"], "size" to it["size"], "contentHash" to it["contentHash"]) },
				"transferKeyDescriptor" to mapOf("type" to "public"),
			),
		)
		val assembled = assembleManifestPlaintext(manifest!!, enc.parts.map { it["raw"] as ByteArray })
		assertArrayEquals(plain, assembled)
	}

	@Test
	fun `multipart plaintext stream roundtrip verifies contentHash`() = runBlocking {
		val plain = ByteArray(FEDERATION_CHUNK_MAX_BYTES.toInt() + 500) { 0x37 }
		val enc = encryptPlaintextToMultiParts(plain, "convergent")
		val manifest = normalizeFileManifest(
			mapOf(
				"ownerEntityHash" to testEntity,
				"logicalPath" to "shells/chat/attachments/streamed",
				"name" to "streamed.bin",
				"mimeType" to "application/octet-stream",
				"size" to plain.size.toDouble(),
				"contentHash" to enc.contentHash,
				"ceMode" to "convergent",
				"parts" to manifestPartsForPersist(enc.parts),
				"transferKeyDescriptor" to mapOf("type" to "public"),
			),
		)!!
		val stream = createManifestPlaintextStream(
			manifest,
			enc.parts.map { chunkSourceOf(it["raw"] as ByteArray) },
			null,
		)
		val chunks = ArrayList<ByteArray>()
		while (true) {
			val chunk = stream.read() ?: break
			chunks.add(chunk)
		}
		var merged = ByteArray(0)
		for (chunk in chunks) merged += chunk
		assertArrayEquals(plain, merged)

		// 篡改一块密文：流须以错误终止而非静默输出坏数据
		val tampered = enc.parts.map { (it["raw"] as ByteArray).copyOf() }
		tampered[1][40] = (tampered[1][40].toInt() xor 0xff).toByte()
		val badStream = createManifestPlaintextStream(
			manifest,
			tampered.map { chunkSourceOf(it) },
			null,
		)
		var failed = false
		try {
			while (true) {
				badStream.read() ?: break
			}
		}
		catch (_: Throwable) {
			failed = true
		}
		assertEquals(true, failed)
	}

	@Test
	fun `normalizeFileManifest rejects invalid parts`() {
		assertNull(normalizeFileManifest(mapOf("ownerEntityHash" to "bad", "logicalPath" to "x", "parts" to emptyList<Any?>())))
	}

	@Test
	fun `assertSafeEvfsLogicalPath rejects traversal`() {
		assertEquals("shells/chat/foo", assertSafeEvfsLogicalPath("shells/chat/foo"))
		assertThrows(IllegalArgumentException::class.java) { assertSafeEvfsLogicalPath("../etc/passwd") }
		assertThrows(IllegalArgumentException::class.java) { assertSafeEvfsLogicalPath("foo/../../bar") }
		assertThrows(IllegalArgumentException::class.java) { assertSafeEvfsLogicalPath("") }
	}

	@Test
	fun `parseEvfsRef rejects malformed refs`() {
		assertNull(parseEvfsRef("evfs:abc"))
		assertNull(parseEvfsRef("evfs://"))
		val ref = formatEvfsRef(testEntity, "shells/chat/x")
		assertEquals(testEntity, parseEvfsRef(ref)?.get("entityHash"))
	}

	@Test
	fun `manifest acl is fail-closed and owner-routed`() = runBlocking {
		val groupEntity = logicalEntityHash(testGroupSubject)

		// 无 matcher：普通实体可读，逻辑实体 deny
		assertEquals(true, canReadManifest("u", testEntity, emptyMap<String, Any?>()))
		assertEquals(false, canReadManifest("u", groupEntity, emptyMap<String, Any?>()))

		// matcher 命中但无 ACL handler → deny
		registerManifestOwner("test") { _, ownerEntityHash -> ownerEntityHash == groupEntity }
		assertEquals(false, canReadManifest("u", groupEntity, emptyMap<String, Any?>()))
		assertEquals(false, canWriteManifestPath("u", groupEntity, "x"))
		unregisterManifestOwner("test")

		// matcher + handler → 走 handler 判定
		registerManifestOwner("test") { _, ownerEntityHash -> ownerEntityHash == groupEntity }
		registerManifestAcl("test") { context, _ -> context.ownerEntityHash == groupEntity }
		assertEquals(true, canReadManifest("u", groupEntity, emptyMap<String, Any?>()))
		assertEquals(true, canReadManifest("u", testEntity, emptyMap<String, Any?>()))
		assertEquals(true, canWriteManifestPath("u", groupEntity, "x"))
		unregisterManifestAcl("test")
		unregisterManifestOwner("test")
	}

	@Test
	fun `nodeHashFromSeed is stable`() {
		val seed = "a".repeat(64)
		assertEquals(nodeHashFromSeed(seed), nodeHashFromSeed(seed))
		assertEquals(true, nodeHashFromSeed(seed) != nodeHashFromSeed("b".repeat(64)))
	}
}
