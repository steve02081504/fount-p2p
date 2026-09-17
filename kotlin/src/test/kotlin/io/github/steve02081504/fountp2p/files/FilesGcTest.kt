package io.github.steve02081504.fountp2p.files

import io.github.steve02081504.fountp2p.files.chunk.ChunkUnlinkResult
import io.github.steve02081504.fountp2p.files.chunk.chunkStoreRoot
import io.github.steve02081504.fountp2p.files.chunk.deleteChunk
import io.github.steve02081504.fountp2p.files.chunk.hasChunk
import io.github.steve02081504.fountp2p.files.chunk.putChunk
import io.github.steve02081504.fountp2p.node.getEntityStore
import io.github.steve02081504.fountp2p.node.withTempNode
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Paths

/** 等价 `js/test/pure/files_gc.test.mjs`。 */
class FilesGcTest {
	private val owner = "b".repeat(128)
	private val orphan = "c".repeat(64)

	private suspend fun writePlainFile(logicalPath: String, plain: String): String {
		val manifest = putFileManifest(
			mapOf(
				"ownerEntityHash" to owner,
				"logicalPath" to logicalPath,
				"plaintext" to plain.toByteArray(Charsets.UTF_8),
				"ceMode" to "plain",
			),
		)
		@Suppress("UNCHECKED_CAST")
		val parts = manifest["parts"] as List<Any?>
		return (parts[0] as Map<*, *>)["hash"] as String
	}

	@Test
	fun `mapChunkGarbage is read-only reports orphans without deleting`() = runBlocking {
		withTempNode("p2p-files-gc-map-") {
			val liveHash = writePlainFile("a.txt", "AAA")
			putChunk(orphan, "ORPHAN".toByteArray(Charsets.UTF_8))

			val report = mapChunkGarbage()
			assertEquals(1L, report.manifests)
			assertEquals(1L, report.referenced)
			assertEquals(listOf(GcChunkTarget(orphan, 6)), report.candidates)
			assertEquals(6L, report.freedBytes)
			assertEquals(0L, report.deleted)

			assertEquals(true, hasChunk(orphan))
			assertEquals(true, hasChunk(liveHash))
		}
	}

	@Test
	fun `cleanChunkGarbage reaps overwritten chunks and keeps live ones`() = runBlocking {
		withTempNode("p2p-files-gc-overwrite-") {
			val oldHash = writePlainFile("a.txt", "V1")
			val newHash = writePlainFile("a.txt", "V2")
			assertEquals(false, oldHash == newHash)

			val report = cleanChunkGarbage()
			assertEquals(1L, report.deleted)
			assertEquals(2L, report.freedBytes)
			assertEquals(false, hasChunk(oldHash))
			assertEquals(true, hasChunk(newHash))

			val prefixes = Files.list(Paths.get(chunkStoreRoot())).use { stream ->
				stream.map { it.fileName.toString() }.toList()
			}
			if (oldHash.substring(0, 2) != newHash.substring(0, 2))
				assertEquals(false, prefixes.contains(oldHash.substring(0, 2)))
		}
	}

	@Test
	fun `cleanChunkGarbage keeps chunks shared across manifests`() = runBlocking {
		withTempNode("p2p-files-gc-shared-") {
			val sharedHash = writePlainFile("x.txt", "SAME")
			val sharedAgain = writePlainFile("y.txt", "SAME")
			assertEquals(sharedHash, sharedAgain)
			putChunk(orphan, "ORPHAN".toByteArray(Charsets.UTF_8))

			val report = cleanChunkGarbage()
			assertEquals(1L, report.deleted)
			assertEquals(true, hasChunk(sharedHash))
			assertEquals(false, hasChunk(orphan))
		}
	}

	@Test
	fun `cleanChunkGarbage targets removes only the given set`() = runBlocking {
		withTempNode("p2p-files-gc-targets-") {
			val liveHash = writePlainFile("a.txt", "AAA")
			val orphanOne = "d".repeat(64)
			val orphanTwo = "e".repeat(64)
			putChunk(orphanOne, "BBBB".toByteArray(Charsets.UTF_8))
			putChunk(orphanTwo, "CCCC".toByteArray(Charsets.UTF_8))

			val partial = cleanChunkGarbage(listOf(orphanOne))
			assertEquals(1L, partial.deleted)
			assertEquals(false, hasChunk(orphanOne))
			assertEquals(true, hasChunk(orphanTwo))
			assertEquals(true, hasChunk(liveHash))

			val full = cleanChunkGarbage()
			assertEquals(1L, full.deleted)
			assertEquals(false, hasChunk(orphanTwo))
			assertEquals(true, hasChunk(liveHash))
		}
	}

	@Test
	fun `cleanChunkGarbage targets rejects invalid hashes`() = runBlocking {
		withTempNode("p2p-files-gc-targets-invalid-") {
			val error = runCatching { cleanChunkGarbage(listOf("0xdeadbeef")) }.exceptionOrNull()
			assertEquals(true, error is IllegalArgumentException)
			assertEquals(true, error?.message?.contains("invalid chunk hash") == true)
		}
	}

	@Test
	fun `cleanChunkGarbage removes broken manifests and reaps their orphans`() = runBlocking {
		withTempNode("p2p-files-gc-broken-") {
			val liveHash = writePlainFile("a.txt", "AAA")
			getEntityStore().writeManifest(owner, "broken.txt", mapOf("foo" to "bar"))
			putChunk(orphan, "ORPHAN".toByteArray(Charsets.UTF_8))

			val mapped = mapChunkGarbage()
			assertEquals(listOf(BrokenManifestRef(owner, "broken.txt")), mapped.brokenManifests)
			assertEquals(listOf(GcChunkTarget(orphan, 6)), mapped.candidates)

			val report = cleanChunkGarbage()
			assertEquals(1L, report.brokenDeleted)
			assertEquals(false, getEntityStore().statManifest(owner, "broken.txt"))
			assertEquals(false, hasChunk(orphan))
			assertEquals(true, hasChunk(liveHash))
		}
	}

	@Test
	fun `deleteFileManifest orphans its chunks for later GC`() = runBlocking {
		withTempNode("p2p-files-gc-delete-manifest-") {
			val hash = writePlainFile("a.txt", "AAA")
			deleteFileManifest(owner, "a.txt")
			assertEquals(false, getEntityStore().statManifest(owner, "a.txt"))

			val report = cleanChunkGarbage()
			assertEquals(1L, report.deleted)
			assertEquals(false, hasChunk(hash))
		}
	}

	@Test
	fun `deleteChunk is a standalone primitive`() = runBlocking {
		withTempNode("p2p-files-gc-delete-chunk-") {
			putChunk(orphan, "X".toByteArray(Charsets.UTF_8))
			assertEquals(true, hasChunk(orphan))

			val result = deleteChunk(orphan)
			assertEquals(ChunkUnlinkResult(true, 1), result)
			assertEquals(false, hasChunk(orphan))

			assertEquals(ChunkUnlinkResult(true, 0), deleteChunk(orphan))
		}
	}
}
