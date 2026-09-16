package io.github.steve02081504.fountp2p.utils

import io.github.steve02081504.fountp2p.deleteRecursively
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

/**
 * 等价 `test/pure/json_io_atomic.test.mjs`：
 * writeJsonFile 固定 `.tmp` 竞态：重叠写同一路径时后 rename 会 ENOENT。
 */
class JsonIoAtomicTest {
	@Test
	fun `writeJsonFile concurrent rewrites of the same path do not ENOENT`() = runBlocking {
		val nodeDir = Files.createTempDirectory("p2p-json-io-")
		val filePath = nodeDir.resolve("personal_block.json").toString()
		try {
			writeJsonFile(filePath, mapOf("blocked" to emptyList<Any?>()))
			val writers = 64
			val results = (0 until writers).map { index ->
				async {
					runCatching {
						writeJsonFile(
							filePath,
							mapOf("blocked" to listOf(mapOf("scope" to "entity", "value" to index.toString().padStart(128, 'a')))),
						)
					}
				}
			}.awaitAll()
			val failures = results.filter { it.isFailure }.map { it.exceptionOrNull().toString() }
			assertEquals(emptyList<String>(), failures)
			val data = readJsonFile(filePath) as Map<*, *>
			assertTrue(data["blocked"] is List<*>)
			assertEquals(1, (data["blocked"] as List<*>).size)
		}
		finally {
			deleteRecursively(nodeDir)
		}
	}

	@Test
	fun `writeJsonFileSync sequential rewrite keeps valid JSON`() {
		val nodeDir = Files.createTempDirectory("p2p-json-io-sync-")
		val filePath = nodeDir.resolve("personal_block.json").toString()
		try {
			writeJsonFileSync(filePath, mapOf("blocked" to emptyList<Any?>()))
			for (i in 0 until 20) writeJsonFileSync(filePath, mapOf("blocked" to listOf(mapOf("i" to i))))
			val expected = mapOf("blocked" to listOf(mapOf("i" to 19.0)))
			assertEquals(expected, readJsonFileSync(filePath))
		}
		finally {
			deleteRecursively(nodeDir)
		}
	}
}
