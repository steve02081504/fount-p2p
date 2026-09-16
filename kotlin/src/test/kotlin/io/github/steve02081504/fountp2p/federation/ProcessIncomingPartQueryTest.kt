package io.github.steve02081504.fountp2p.federation

import io.github.steve02081504.fountp2p.federation.part_query.PartQueryDependencies
import io.github.steve02081504.fountp2p.federation.part_query.PartQueryWire
import io.github.steve02081504.fountp2p.federation.part_query.QueryInboundContext
import io.github.steve02081504.fountp2p.federation.part_query.createPartQueryNodeState
import io.github.steve02081504.fountp2p.federation.part_query.processIncomingPartQueryRequest
import io.github.steve02081504.fountp2p.federation.part_query.registerQueryInboundHandler
import io.github.steve02081504.fountp2p.schemas.parsePartQueryReq
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

/** `processIncomingPartQueryRequest` 基础路径（ttl 用尽 -> 本地应答）。 */
class ProcessIncomingPartQueryTest {
	private val nodeA = "aa".repeat(32)
	private val nodeB = "bb".repeat(32)
	private val resPub = "ab".repeat(32)
	private val resSig = "cd".repeat(64)

	@Test
	fun `processIncoming answers locally when ttl is exhausted`() = runBlocking {
		val state = createPartQueryNodeState()
		registerQueryInboundHandler("shells/social", "entity_search", { _, _ -> listOf(mapOf("id" to "x")) }, state)
		val sent = mutableListOf<Pair<String, Any?>>()
		val wire = PartQueryWire { action, payload, _ -> sent.add(action to payload) }
		val dependencies = PartQueryDependencies(
			state = state,
			getNodeHash = { nodeA },
			signResponse = { mapOf("nodePubKey" to resPub, "sig" to resSig) },
			now = { 1000L },
		)
		val request = parsePartQueryReq(
			mapOf(
				"requestId" to "req-x",
				"originNodeHash" to nodeB,
				"partpath" to "shells/social",
				"kind" to "entity_search",
				"query" to mapOf("q" to "x"),
				"ttl" to 1,
				"budget" to mapOf("maxHits" to 8),
			),
		)!!
		processIncomingPartQueryRequest(QueryInboundContext(replicaUsername = ""), wire, request, nodeB, dependencies)

		val deadline = System.currentTimeMillis() + 2_000
		while (sent.isEmpty() && System.currentTimeMillis() < deadline) delay(5)
		assertEquals(1, sent.size)
		assertEquals("part_query_res", sent[0].first)
		val payload = sent[0].second as Map<String, Any?>
		assertEquals("req-x", payload["requestId"])
		assertEquals(nodeA, payload["fromNodeHash"])
		val rows = payload["rows"] as List<*>
		assertEquals("x", (rows[0] as Map<*, *>)["id"])
	}
}
