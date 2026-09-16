package io.github.steve02081504.fountp2p.federation

import io.github.steve02081504.fountp2p.federation.part_query.OriginBag
import io.github.steve02081504.fountp2p.federation.part_query.PartQueryDependencies
import io.github.steve02081504.fountp2p.federation.part_query.createPartQueryCache
import io.github.steve02081504.fountp2p.federation.part_query.createPartQueryNodeState
import io.github.steve02081504.fountp2p.federation.part_query.handleIncomingPartQueryResponse
import io.github.steve02081504.fountp2p.federation.part_query.mergeQueryRows
import io.github.steve02081504.fountp2p.federation.part_query.partQueryCacheKey
import io.github.steve02081504.fountp2p.federation.part_query.resolvePartQueryHopTimeoutMs
import io.github.steve02081504.fountp2p.schemas.normalizePartQueryCacheMaterial
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 等价 `test/pure/part_query.test.mjs` 中 federation 部分。 */
class PartQueryTest {
	private val nodeB = "bb".repeat(32)
	private val resPub = "ab".repeat(32)
	private val resSig = "cd".repeat(64)

	@Test
	fun `duplicate part_query_res from the same peer counts once`() = runBlocking {
		val state = createPartQueryNodeState()
		state.originBags["r1"] = OriginBag(
			maxHits = 8,
			expected = 2,
			rowKey = { row -> ((row as Map<*, *>)["id"]).toString() },
		)
		val dependencies = PartQueryDependencies(state = state, verifyResponse = { true })
		val response = mapOf<String, Any?>(
			"requestId" to "r1",
			"fromNodeHash" to nodeB,
			"rows" to listOf(mapOf("id" to "b")),
			"nodePubKey" to resPub,
			"sig" to resSig,
		)
		handleIncomingPartQueryResponse(response, nodeB, dependencies)
		handleIncomingPartQueryResponse(
			response + mapOf("rows" to listOf(mapOf("id" to "b2"))),
			nodeB,
			dependencies,
		)
		val bag = state.originBags["r1"]!!
		assertEquals(1, bag.received)
		assertEquals(1, bag.entries.size)
		assertEquals(listOf("b"), bag.entries[0].rows.map { (it as Map<*, *>)["id"] })
	}

	@Test
	fun `handleIncomingPartQueryResponse drops responses that fail verification`() = runBlocking {
		val state = createPartQueryNodeState()
		state.originBags["r1"] = OriginBag(
			maxHits = 8,
			expected = 2,
			rowKey = { row -> ((row as Map<*, *>)["id"]).toString() },
		)
		val dependencies = PartQueryDependencies(state = state, verifyResponse = { false })
		handleIncomingPartQueryResponse(
			mapOf(
				"requestId" to "r1",
				"fromNodeHash" to nodeB,
				"rows" to listOf(mapOf("id" to "b")),
				"nodePubKey" to resPub,
				"sig" to resSig,
			),
			nodeB,
			dependencies,
		)
		val bag = state.originBags["r1"]!!
		assertEquals(0, bag.received)
		assertEquals(0, bag.entries.size)
	}

	@Test
	fun `cache key is stable under key order and distinct across kinds`() {
		val a = partQueryCacheKey("shells/social", "entity_search", linkedMapOf("b" to 2.0, "a" to 1.0))
		val b = partQueryCacheKey("shells/social", "entity_search", linkedMapOf("a" to 1.0, "b" to 2.0))
		val c = partQueryCacheKey("shells/social", "post_search", linkedMapOf("a" to 1.0, "b" to 2.0))
		assertEquals(a, b)
		assertEquals(false, a == c)
		assertNotNull(normalizePartQueryCacheMaterial("shells/social", "entity_search", mapOf("a" to 1.0)))
	}

	@Test
	fun `part query cache TTL and LRU capacity`() {
		val cache = createPartQueryCache(mapOf("maxKeys" to 2, "ttlMs" to 1000, "maxHits" to 8))
		var now = 1000L
		cache.set("shells/social", "entity_search", mapOf("q" to "a"), listOf(mapOf("id" to "a")), now)
		cache.set("shells/social", "entity_search", mapOf("q" to "b"), listOf(mapOf("id" to "b")), now)
		cache.set("shells/social", "entity_search", mapOf("q" to "c"), listOf(mapOf("id" to "c")), now)
		assertEquals(2, cache.size)
		assertNull(cache.get("shells/social", "entity_search", mapOf("q" to "a"), now))
		val rowC = cache.get("shells/social", "entity_search", mapOf("q" to "c"), now)?.get(0) as Map<*, *>
		assertEquals("c", rowC["id"])
		now += 1001
		assertNull(cache.get("shells/social", "entity_search", mapOf("q" to "c"), now))
	}

	@Test
	fun `part query cache refuses empty rows`() {
		val cache = createPartQueryCache(mapOf("maxKeys" to 8, "ttlMs" to 1000))
		cache.set("shells/social", "entity_search", mapOf("q" to "miss"), emptyList(), 1000)
		assertEquals(0, cache.size)
		assertNull(cache.get("shells/social", "entity_search", mapOf("q" to "miss"), 1000))
	}

	@Test
	fun `mergeQueryRows dedupes by rowKey and respects maxHits`() {
		val rows = mergeQueryRows(
			listOf(
				listOf(mapOf("id" to "a"), mapOf("id" to "b")),
				listOf(mapOf("id" to "b"), mapOf("id" to "c")),
			),
			2,
			{ row -> ((row as Map<*, *>)["id"]).toString() },
		)
		assertEquals(listOf("a", "b"), rows.map { (it as Map<*, *>)["id"] })
	}

	@Test
	fun `hop timeouts scale with ttl`() {
		assertEquals(1000.0, resolvePartQueryHopTimeoutMs(1), 0.0)
		assertEquals(2500.0, resolvePartQueryHopTimeoutMs(2), 0.0)
		assertEquals(4000.0, resolvePartQueryHopTimeoutMs(3), 0.0)
		// 发起端取 ttl+1 档，须严格长于第一跳中继的 hopTimeout(maxTtl)
		assertTrue(resolvePartQueryHopTimeoutMs(4) > resolvePartQueryHopTimeoutMs(3))
	}
}
