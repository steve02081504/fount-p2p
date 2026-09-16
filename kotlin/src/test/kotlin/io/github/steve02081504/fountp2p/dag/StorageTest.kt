package io.github.steve02081504.fountp2p.dag

import io.github.steve02081504.fountp2p.deleteRecursively
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

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
	fun `jsonlMutexKey prefixes the path`() {
		assertEquals("jsonl:/tmp/x.jsonl", jsonlMutexKey("/tmp/x.jsonl"))
	}
}
