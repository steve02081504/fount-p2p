package io.github.steve02081504.fountp2p.wire.part

import io.github.steve02081504.fountp2p.awaitCondition
import io.github.steve02081504.fountp2p.federation.part_query.PartQueryDependencies
import io.github.steve02081504.fountp2p.federation.part_query.PartQueryNodeState
import io.github.steve02081504.fountp2p.federation.part_query.createPartQueryNodeState
import io.github.steve02081504.fountp2p.federation.part_query.registerQueryInboundHandler
import io.github.steve02081504.fountp2p.wire.DefaultWireContext
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** `wire/part/query.mjs` 的等价测试。 */
class PartQueryWireTest {
	private val wire = PartMemoryWire()
	private val selfHash = "ab".repeat(32)
	private val originHash = "cd".repeat(32)

	private fun dependencies(state: PartQueryNodeState) = PartQueryDependencies(
		selectNeighbors = { emptyList() },
		deliver = { _, _, _ -> true },
		getNodeHash = { selfHash },
		signResponse = { mapOf("nodePubKey" to "ee".repeat(32), "sig" to "ff".repeat(64)) },
		verifyResponse = { true },
		state = state,
	)

	private fun request(requestId: String, ttl: Int = 1) = linkedMapOf<String, Any?>(
		"requestId" to requestId,
		"originNodeHash" to originHash,
		"partpath" to "shells/social",
		"kind" to "entity_search",
		"query" to mapOf("q" to "x"),
		"ttl" to ttl.toDouble(),
		"budget" to mapOf("maxHits" to 8.0),
	)

	@Test
	fun `part_query_req with ttl 1 answers from local handler`() = runBlocking {
		val state = createPartQueryNodeState()
		registerQueryInboundHandler("shells/social", "entity_search", { _, _ -> listOf(mapOf("id" to "r1")) }, state)
		attachPartQueryWire(DefaultWireContext("alice"), wire, dependencies(state))

		wire.dispatch("part_query_req", request("q1"), "peer-a")

		awaitCondition { wire.sent.isNotEmpty() }
		val (name, payload, peerId) = wire.sent[0]
		assertEquals("part_query_res", name)
		assertEquals("peer-a", peerId)
		@Suppress("UNCHECKED_CAST")
		val body = payload as Map<String, Any?>
		assertEquals("q1", body["requestId"])
		assertEquals(selfHash, body["fromNodeHash"])
		assertEquals(listOf(mapOf("id" to "r1")), body["rows"])
		assertEquals("ee".repeat(32), body["nodePubKey"])
		assertEquals("ff".repeat(64), body["sig"])
	}

	@Test
	fun `duplicate requestId is dropped by dedupe`() = runBlocking {
		val state = createPartQueryNodeState()
		registerQueryInboundHandler("shells/social", "entity_search", { _, _ -> listOf(mapOf("id" to "r1")) }, state)
		attachPartQueryWire(DefaultWireContext("alice"), wire, dependencies(state))

		wire.dispatch("part_query_req", request("dup"), "peer-a")
		wire.dispatch("part_query_req", request("dup"), "peer-a")

		awaitCondition { wire.sent.isNotEmpty() }
		Thread.sleep(80)
		assertEquals(1, wire.sent.size)
	}

	@Test
	fun `invalid part_query_req payloads are ignored`() = runBlocking {
		val state = createPartQueryNodeState()
		attachPartQueryWire(DefaultWireContext("alice"), wire, dependencies(state))

		wire.dispatch("part_query_req", "not-an-object", "peer-a")
		wire.dispatch("part_query_req", mapOf("requestId" to "", "originNodeHash" to originHash), "peer-a")
		wire.dispatch(
			"part_query_req",
			linkedMapOf<String, Any?>(
				"requestId" to "q-bad",
				"originNodeHash" to "not-hex",
				"partpath" to "shells/social",
				"kind" to "entity_search",
				"query" to mapOf<String, Any?>(),
				"ttl" to 1.0,
			),
			"peer-a",
		)
		wire.dispatch(
			"part_query_req",
			linkedMapOf<String, Any?>(
				"requestId" to "q-bad2",
				"originNodeHash" to originHash,
				"partpath" to "bad path",
				"kind" to "entity_search",
				"query" to mapOf<String, Any?>(),
				"ttl" to 1.0,
			),
			"peer-a",
		)

		Thread.sleep(80)
		assertTrue(wire.sent.isEmpty())
	}

	@Test
	fun `valid part_query_res is accepted and unknown requestId ignored`() = runBlocking {
		val state = createPartQueryNodeState()
		attachPartQueryWire(DefaultWireContext("alice"), wire, dependencies(state))

		wire.dispatch(
			"part_query_res",
			linkedMapOf<String, Any?>(
				"requestId" to "unknown",
				"fromNodeHash" to originHash,
				"rows" to listOf(mapOf("a" to 1.0)),
				"nodePubKey" to "ee".repeat(32),
				"sig" to "ff".repeat(64),
			),
			"peer-a",
		)
		wire.dispatch("part_query_res", mapOf("requestId" to "x"), "peer-a")

		Thread.sleep(80)
		assertTrue(wire.sent.isEmpty())
	}

	@Test
	fun `attachPartQueryWire dispose stops handlers`() = runBlocking {
		val state = createPartQueryNodeState()
		val dispose = attachPartQueryWire(DefaultWireContext("alice"), wire, dependencies(state))
		dispose()
		assertEquals(0, wire.handlers["part_query_req"]?.size ?: 0)
		assertEquals(0, wire.handlers["part_query_res"]?.size ?: 0)
	}

	@Test
	fun `withDefaultDeliver injects default only when absent`() {
		val injected: suspend (String, String, Any?) -> Boolean = { _, _, _ -> false }
		assertSame(injected, withDefaultDeliver(PartQueryDependencies(deliver = injected)).deliver)
		assertNotNull(withDefaultDeliver(PartQueryDependencies()).deliver)
	}
}
