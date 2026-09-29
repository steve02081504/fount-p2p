package io.github.steve02081504.fountp2p.dag

import io.github.steve02081504.fountp2p.deleteRecursively
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** 等价 `test/integration/dag_storage_enoent.test.mjs` 及 `dag/storage.mjs` 行为。 */
class StorageTest {
	private fun tempDir(): Path = Files.createTempDirectory("fount-p2p-dag-")

	@Test
	fun `readJsonl returns empty list for missing file`() = runBlocking {
		val dir = tempDir()
		try {
			val missing = dir.resolve("nope.jsonl").toString()
			assertEquals(emptyList<Map<String, Any?>>(), readJsonl(missing))
		}
		finally {
			deleteRecursively(dir)
		}
	}

	@Test
	fun `readJsonlStream yields nothing for missing file`() = runBlocking {
		val dir = tempDir()
		try {
			val missing = dir.resolve("gone.jsonl").toString()
			assertEquals(emptyList<Map<String, Any?>>(), readJsonlStream(missing).toList())
		}
		finally {
			deleteRecursively(dir)
		}
	}

	@Test
	fun `readJsonlStream survives cleanup race after file deleted`() = runBlocking {
		val dir = tempDir()
		try {
			val path = dir.resolve("events.jsonl")
			Files.writeString(path, "{\"id\":\"a\"}\n{\"id\":\"b\"}\n")
			val ids = readJsonlStream(path.toString()).toList().map { it["id"] as String }
			assertEquals(listOf("a", "b"), ids.sorted())
			Files.delete(path)
			assertEquals(emptyList<Map<String, Any?>>(), readJsonlStream(path.toString()).toList())
		}
		finally {
			deleteRecursively(dir)
		}
	}

	@Test
	fun `readJsonl skips torn trailing line and keeps prior rows`() = runBlocking {
		val dir = tempDir()
		try {
			val path = dir.resolve("events.jsonl")
			Files.writeString(path, "{\"id\":\"a\"}\n{\"id\":\"b\"}\n{\"id\":\"c\"")
			assertEquals(
				listOf(mapOf<String, Any?>("id" to "a"), mapOf<String, Any?>("id" to "b")),
				readJsonl(path.toString()),
			)
		}
		finally {
			deleteRecursively(dir)
		}
	}

	@Test
	fun `readJsonl applies sanitize and skips bad rows`() = runBlocking {
		val dir = tempDir()
		try {
			val path = dir.resolve("events.jsonl")
			Files.writeString(path, "{\"id\":\"a\"}\nnot json\n\n{\"id\":\"b\"}\n")
			val rows = readJsonl(path.toString()) { row ->
				LinkedHashMap(row).apply { this["sanitized"] = true }
			}
			assertEquals(listOf("a", "b"), rows.map { it["id"] as String })
			assertEquals(listOf(true, true), rows.map { it["sanitized"] as Boolean })
		}
		finally {
			deleteRecursively(dir)
		}
	}

	@Test
	fun `writeJsonl and readJsonlTipId roundtrip`() = runBlocking {
		val dir = tempDir()
		try {
			val path = dir.resolve("nested/events.jsonl")
			writeJsonl(path.toString(), listOf(mapOf<String, Any?>("id" to "a"), mapOf<String, Any?>("id" to "b")))
			assertEquals(listOf(mapOf<String, Any?>("id" to "a"), mapOf<String, Any?>("id" to "b")), readJsonl(path.toString()))
			assertEquals("b", readJsonlTipId(path.toString()))
			assertNull(readJsonlTipId(dir.resolve("empty.jsonl").toString()))
		}
		finally {
			deleteRecursively(dir)
		}
	}

	@Test
	fun `rewriteJsonlKeeping filters rows and reports counts`() = runBlocking {
		val dir = tempDir()
		try {
			val path = dir.resolve("events.jsonl")
			writeJsonl(path.toString(), listOf(mapOf<String, Any?>("id" to "a"), mapOf<String, Any?>("id" to "b"), mapOf<String, Any?>("id" to "c")))
			val stats = rewriteJsonlKeeping(path.toString(), { row -> row["id"] != "b" })
			assertEquals(2 to 1, stats)
			assertEquals(listOf(mapOf<String, Any?>("id" to "a"), mapOf<String, Any?>("id" to "c")), readJsonl(path.toString()))
		}
		finally {
			deleteRecursively(dir)
		}
	}

	@Test
	fun `writeJsonAtomic uses tab indentation`() = runBlocking {
		val dir = tempDir()
		try {
			val path = dir.resolve("data.json")
			writeJsonAtomic(path.toString(), mapOf<String, Any?>("a" to 1.0))
			assertEquals("{\n\t\"a\": 1\n}", Files.readString(path))
		}
		finally {
			deleteRecursively(dir)
		}
	}

	@Test
	fun `rewriteJsonlKeeping serializes with appendJsonlSynced`() = runBlocking {
		val dir = tempDir()
		try {
			val path = dir.resolve("events.jsonl")
			writeJsonl(path.toString(), listOf(mapOf<String, Any?>("id" to "a")))
			val entered = CountDownLatch(1)
			val release = CountDownLatch(1)
			val rewrite = launch(Dispatchers.IO) {
				rewriteJsonlKeeping(path.toString(), { _ ->
					entered.countDown()
					release.await()
					true
				})
			}
			assertTrue(entered.await(2, TimeUnit.SECONDS))
			val append = launch(Dispatchers.IO) {
				appendJsonlSynced(path.toString(), mapOf<String, Any?>("id" to "b"))
			}
			delay(50)
			assertFalse(append.isCompleted)
			release.countDown()
			joinAll(rewrite, append)
			assertEquals(listOf("a", "b"), readJsonl(path.toString()).map { it["id"] })
		}
		finally {
			deleteRecursively(dir)
		}
	}

	@Test
	fun `rewriteJsonlKeeping leaves original untouched when keep throws`() = runBlocking {
		val dir = tempDir()
		try {
			val path = dir.resolve("events.jsonl")
			val original = "{\"id\":\"a\"}\n"
			Files.writeString(path, original)
			var threw = false
			try {
				rewriteJsonlKeeping(path.toString(), { throw IllegalStateException("boom") })
			}
			catch (_: IllegalStateException) {
				threw = true
			}
			assertTrue(threw)
			assertEquals(original, Files.readString(path))
			val leftovers = Files.newDirectoryStream(dir).use { stream ->
				stream.filter { it.fileName.toString().startsWith("events.jsonl.tmp.") }.toList()
			}
			assertEquals(emptyList<Path>(), leftovers)
		}
		finally {
			deleteRecursively(dir)
		}
	}

	@Test
	fun `rewriteJsonlKeeping is a no-op when nothing is dropped`() = runBlocking {
		val dir = tempDir()
		try {
			val path = dir.resolve("events.jsonl")
			val original = "{\"id\":\"a\",   \"x\": 1}\n"
			Files.writeString(path, original)
			val before = Files.getLastModifiedTime(path)
			val stats = rewriteJsonlKeeping(path.toString(), { true })
			assertEquals(1 to 0, stats)
			assertEquals(original, Files.readString(path))
			assertEquals(before, Files.getLastModifiedTime(path))
		}
		finally {
			deleteRecursively(dir)
		}
	}

	@Test
	fun `rewriteJsonlKeeping drops every row to an empty file`() = runBlocking {
		val dir = tempDir()
		try {
			val path = dir.resolve("events.jsonl")
			Files.writeString(path, "{\"id\":\"a\"}\n{\"id\":\"b\"}\n")
			val stats = rewriteJsonlKeeping(path.toString(), { false })
			assertEquals(0 to 2, stats)
			assertEquals(0L, Files.size(path))
			assertEquals(emptyList<Map<String, Any?>>(), readJsonl(path.toString()))
		}
		finally {
			deleteRecursively(dir)
		}
	}

	@Test
	fun `rewriteJsonlKeeping returns 0 0 and creates nothing for missing source`() = runBlocking {
		val dir = tempDir()
		try {
			val missingParent = dir.resolve("missing")
			val path = missingParent.resolve("events.jsonl")
			assertEquals(0 to 0, rewriteJsonlKeeping(path.toString(), { true }))
			assertFalse(Files.exists(missingParent))
			assertFalse(Files.exists(Paths.get(path.toString())))
		}
		finally {
			deleteRecursively(dir)
		}
	}

	@Test
	fun `rewriteJsonlKeeping writes original raw lines not reserialized sanitized rows`() = runBlocking {
		val dir = tempDir()
		try {
			val path = dir.resolve("events.jsonl")
			val rawKept = "{\"id\":\"a\",  \"extra\":\"x\"}"
			val rawDropped = "{\"id\":\"b\"}"
			Files.writeString(path, "$rawKept\n$rawDropped\n")
			val stats = rewriteJsonlKeeping(
				path.toString(),
				{ row -> row["id"] != "b" },
				{ row -> LinkedHashMap(row).apply { remove("extra") } },
			)
			assertEquals(1 to 1, stats)
			assertEquals("$rawKept\n", Files.readString(path))
		}
		finally {
			deleteRecursively(dir)
		}
	}

	@Test
	fun `rewriteJsonlKeeping removes invalid lines`() = runBlocking {
		val dir = tempDir()
		try {
			val path = dir.resolve("events.jsonl")
			Files.writeString(path, "{\"id\":\"a\"}\nnot json\n{\"id\":\"b\"}\n")
			val stats = rewriteJsonlKeeping(path.toString(), { true })
			assertEquals(2 to 1, stats)
			assertEquals("{\"id\":\"a\"}\n{\"id\":\"b\"}\n", Files.readString(path))
		}
		finally {
			deleteRecursively(dir)
		}
	}

	@Test
	fun `readJsonl throws on non-ENOENT read error`() = runBlocking {
		val dir = tempDir()
		try {
			var threw = false
			try {
				readJsonl(dir.toString())
			}
			catch (_: Exception) {
				threw = true
			}
			assertTrue(threw)
		}
		finally {
			deleteRecursively(dir)
		}
	}

	@Test
	fun `readJsonlEntries keeps raw lines and skips bad ones`() = runBlocking {
		val dir = tempDir()
		try {
			val path = dir.resolve("events.jsonl")
			Files.writeString(path, "{\"id\":\"a\"}\n\nnot json\n{\"id\":\"b\"}\n")
			val entries = readJsonlEntries(path.toString())
			assertEquals(listOf("a", "b"), entries.map { it.row["id"] as String })
		}
		finally {
			deleteRecursively(dir)
		}
	}

	@Test
	fun `readJsonlTipId falls back to last parseable line`() = runBlocking {
		val dir = tempDir()
		try {
			val path = dir.resolve("events.jsonl")
			Files.writeString(path, "{\"id\":\"a\"}\n{\"id\":\"b\"}\n{\"id\":")
			assertEquals("b", readJsonlTipId(path.toString()))
			Files.writeString(path, "{\"id\":\"torn\"")
			assertNull(readJsonlTipId(path.toString()))
		}
		finally {
			deleteRecursively(dir)
		}
	}

	@Test
	fun `jsonlMutexKey normalizes relative and absolute paths`() {
		val dir = tempDir()
		try {
			val absolute = dir.resolve("x.jsonl")
			val dotted = dir.resolve("nested/../x.jsonl").toString()
			val cwd = Paths.get("").toAbsolutePath().normalize()
			val relative = cwd.relativize(absolute)
			assertEquals(jsonlMutexKey(absolute.toString()), jsonlMutexKey(dotted))
			assertEquals(jsonlMutexKey(absolute.toString()), jsonlMutexKey(relative.toString()))
		}
		finally {
			deleteRecursively(dir)
		}
	}
}
