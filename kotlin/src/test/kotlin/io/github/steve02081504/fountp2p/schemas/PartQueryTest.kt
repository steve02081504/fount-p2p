package io.github.steve02081504.fountp2p.schemas

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 等价 `test/pure/part_query.test.mjs` 中 schemas 部分。 */
class PartQueryTest {
	private val nodeA = "aa".repeat(32)
	private val nodeB = "bb".repeat(32)
	private val resPub = "ab".repeat(32)
	private val resSig = "cd".repeat(64)

	private fun validRes(patch: Map<String, Any?> = emptyMap()): LinkedHashMap<String, Any?> =
		linkedMapOf<String, Any?>(
			"requestId" to "r",
			"fromNodeHash" to nodeB,
			"rows" to emptyList<Any?>(),
			"nodePubKey" to resPub,
			"sig" to resSig,
		).apply { putAll(patch) }

	private fun validReq(patch: Map<String, Any?> = emptyMap()): LinkedHashMap<String, Any?> =
		linkedMapOf<String, Any?>(
			"requestId" to "req-1",
			"originNodeHash" to nodeA,
			"partpath" to "shells/social",
			"kind" to "entity_search",
			"query" to mapOf("q" to "alice"),
			"ttl" to 3,
			"budget" to mapOf("maxHits" to 16),
		).apply { putAll(patch) }

	@Test
	fun `parsePartQueryReq rejects missing fields and oversize query`() {
		assertNull(parsePartQueryReq(null))
		assertNull(parsePartQueryReq(validReq(mapOf("requestId" to ""))))
		assertNull(parsePartQueryReq(validReq(mapOf("originNodeHash" to "zz"))))
		assertNull(parsePartQueryReq(validReq(mapOf("partpath" to "bad:path"))))
		assertNull(parsePartQueryReq(validReq(mapOf("kind" to ""))))
		assertNull(parsePartQueryReq(validReq(mapOf("ttl" to 0))))
		val big = "x".repeat(3000)
		assertNull(parsePartQueryReq(validReq(mapOf("query" to mapOf("big" to big)))))
		assertNull(parsePartQueryReq(validReq(mapOf("requestId" to "r".repeat(129)))))
		assertNull(parsePartQueryRes(validRes(mapOf("requestId" to "r".repeat(129)))))
	}

	@Test
	fun `parsePartQueryReq clamps ttl and budget maxHits`() {
		val request = parsePartQueryReq(validReq(mapOf("ttl" to 99, "budget" to mapOf("maxHits" to 999))))
		assertEquals(3, request?.get("ttl"))
		@Suppress("UNCHECKED_CAST")
		val budget = request?.get("budget") as Map<*, *>
		assertEquals(32L, budget["maxHits"])
	}

	@Test
	fun `parsePartQueryRes rejects bad rows, node hash, signature`() {
		assertNull(parsePartQueryRes(validRes(mapOf("rows" to "nope"))))
		assertNull(parsePartQueryRes(validRes(mapOf("fromNodeHash" to "x"))))
		assertNull(parsePartQueryRes(validRes(mapOf("nodePubKey" to "zz"))))
		assertNull(parsePartQueryRes(validRes(mapOf("sig" to "nothex"))))
		assertNull(parsePartQueryRes(validRes().apply { remove("sig") }))
		val ok = parsePartQueryRes(validRes(mapOf("rows" to listOf(mapOf("id" to 1)))))
		assertEquals(1, (ok?.get("rows") as List<*>).size)
	}

	@Test
	fun `clamp helpers and hop timeouts`() {
		assertEquals(2, clampPartQueryTtl(2))
		assertEquals(3, clampPartQueryTtl(9))
		@Suppress("UNCHECKED_CAST")
		assertEquals(32L, (clampPartQueryBudget(mapOf("maxHits" to 100)) as Map<String, Any?>)["maxHits"])
		assertTrue(measureJsonBytes(mapOf("a" to 1)) > 0)
		assertEquals(1000L, PartQueryTunables.hopTimeoutMs[0])
		assertTrue(PartQueryTunables.defaultTimeoutMs > 0)
	}

	@Test
	fun `cache material stable under key order and distinct across kinds`() {
		val a = normalizePartQueryCacheMaterial("shells/social", "entity_search", mapOf("b" to 2, "a" to 1))
		val b = normalizePartQueryCacheMaterial("shells/social", "entity_search", mapOf("a" to 1, "b" to 2))
		val c = normalizePartQueryCacheMaterial("shells/social", "post_search", mapOf("a" to 1, "b" to 2))
		assertEquals(a, b)
		assertEquals(false, a == c)
		assertNotNull(normalizePartQueryCacheMaterial("shells/social", "entity_search", mapOf("a" to 1)))
	}
}
