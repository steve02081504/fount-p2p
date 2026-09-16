package io.github.steve02081504.fountp2p.federation

import io.github.steve02081504.fountp2p.federation.part_query.PartQueryDependencies
import io.github.steve02081504.fountp2p.federation.part_query.PartQueryQueryOptions
import io.github.steve02081504.fountp2p.federation.part_query.createPartQueryNodeState
import io.github.steve02081504.fountp2p.federation.part_query.handleIncomingPartQueryResponse
import io.github.steve02081504.fountp2p.federation.part_query.queryNetwork
import io.github.steve02081504.fountp2p.federation.part_query.registerQueryInboundHandler
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 等价 `test/integration/part_query.test.mjs` 中可注入依赖的核心用例
 * （不依赖尚未移植的 wire/trust_graph 默认实现）。
 */
class QueryNetworkTest {
	private val nodeA = "aa".repeat(32)
	private val nodeB = "bb".repeat(32)
	private val resPub = "ab".repeat(32)
	private val resSig = "cd".repeat(64)

	private fun rowKey(row: Any?): String = ((row as Map<*, *>)["id"]).toString()

	private fun fakeSign(base: Map<String, Any?>): Map<String, Any?> =
		mapOf("nodePubKey" to resPub, "sig" to resSig)

	@Test
	fun `one-hop answer aggregates local and neighbor rows`() = runBlocking {
		val state = createPartQueryNodeState()
		registerQueryInboundHandler("shells/social", "entity_search", { _, _ -> listOf(mapOf("id" to "a-local")) }, state)
		lateinit var dependencies: PartQueryDependencies
		dependencies = PartQueryDependencies(
			state = state,
			getNodeHash = { nodeA },
			selectNeighbors = { listOf(nodeB) },
			signResponse = ::fakeSign,
			verifyResponse = { true },
			deliver = { _, action, payload ->
				if (action == "part_query_req") {
					val request = payload as Map<String, Any?>
					handleIncomingPartQueryResponse(
						mapOf(
							"requestId" to request["requestId"],
							"fromNodeHash" to nodeB,
							"rows" to listOf(mapOf("id" to "b-hit")),
							"nodePubKey" to resPub,
							"sig" to resSig,
						),
						nodeB,
						dependencies,
					)
				}
				true
			},
		)
		val result = queryNetwork(
			"alice",
			"shells/social",
			"entity_search",
			mapOf("q" to "alice"),
			PartQueryQueryOptions(ttl = 1, timeoutMs = 500, rowKey = ::rowKey, dependencies = dependencies),
		)
		assertEquals(listOf("a-local", "b-hit"), result.rows.map { ((it as Map<*, *>)["id"] as String) }.sorted())
		assertEquals(listOf(nodeB), result.sources["b-hit"])
		assertEquals(emptyList<String>(), result.sources["a-local"])
	}

	@Test
	fun `queryNetwork filters rows whose only source is blocked`() = runBlocking {
		val state = createPartQueryNodeState()
		registerQueryInboundHandler("shells/social", "entity_search", { _, _ -> listOf(mapOf("id" to "a-local")) }, state)
		lateinit var dependencies: PartQueryDependencies
		dependencies = PartQueryDependencies(
			state = state,
			getNodeHash = { nodeA },
			selectNeighbors = { listOf(nodeB) },
			signResponse = ::fakeSign,
			verifyResponse = { true },
			deliver = { _, action, payload ->
				if (action == "part_query_req") {
					val request = payload as Map<String, Any?>
					handleIncomingPartQueryResponse(
						mapOf(
							"requestId" to request["requestId"],
							"fromNodeHash" to nodeB,
							"rows" to listOf(mapOf("id" to "b-hit")),
							"nodePubKey" to resPub,
							"sig" to resSig,
						),
						nodeB,
						dependencies,
					)
				}
				true
			},
		)
		val result = queryNetwork(
			"alice",
			"shells/social",
			"entity_search",
			mapOf("q" to "alice"),
			PartQueryQueryOptions(
				ttl = 1,
				timeoutMs = 500,
				rowKey = ::rowKey,
				isSourceBlocked = { it == nodeB },
				dependencies = dependencies,
			),
		)
		assertEquals(listOf("a-local"), result.rows.map { ((it as Map<*, *>)["id"] as String) })
	}

	@Test
	fun `queryNetwork respects timeoutMs even when deliver hangs`() = runBlocking {
		val state = createPartQueryNodeState()
		registerQueryInboundHandler("shells/social", "entity_search", { _, _ -> listOf(mapOf("id" to "a-local")) }, state)
		val dependencies = PartQueryDependencies(
			state = state,
			getNodeHash = { nodeA },
			selectNeighbors = { listOf(nodeB) },
			deliver = { _, _, _ ->
				delay(10_000)
				false
			},
		)
		val startedAt = System.currentTimeMillis()
		val result = queryNetwork(
			"alice",
			"shells/social",
			"entity_search",
			mapOf("q" to "hang"),
			PartQueryQueryOptions(ttl = 1, timeoutMs = 80, rowKey = ::rowKey, dependencies = dependencies),
		)
		assertEquals(listOf("a-local"), result.rows.map { ((it as Map<*, *>)["id"] as String) })
		assertTrue(System.currentTimeMillis() - startedAt < 5_000)
	}
}
