package io.github.steve02081504.fountp2p.federation.part_query

import io.github.steve02081504.fountp2p.awaitCondition
import io.github.steve02081504.fountp2p.node.NetworkData
import io.github.steve02081504.fountp2p.node.getNodeHash
import io.github.steve02081504.fountp2p.node.saveNetwork
import io.github.steve02081504.fountp2p.node.withTempNode
import io.github.steve02081504.fountp2p.wire.DefaultWireContext
import io.github.steve02081504.fountp2p.wire.part.PartMemoryWire
import io.github.steve02081504.fountp2p.wire.part.attachPartQueryWire
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `PartQueryDependencies` 未注入时的默认实现等价测试
 * （JS `defaultSignResponse` / `defaultVerifyResponse` / `selectQueryNeighbors` / `getNodeHash`）。
 */
class DefaultDependenciesTest {
	private val partpath = "shells/social"
	private val kind = "entity_search"
	private val originHash = "cd".repeat(32)

	private fun request(requestId: String) = linkedMapOf<String, Any?>(
		"requestId" to requestId,
		"originNodeHash" to originHash,
		"partpath" to partpath,
		"kind" to kind,
		"query" to mapOf("q" to "x"),
		"ttl" to 1.0,
	)

	/**
	 * 发送侧走默认签名（不注入 signResponse / getNodeHash），返回已签名的 part_query_res。
	 * @param requestId 请求 id
	 * @return 响应载荷
	 */
	private suspend fun collectSignedResponse(requestId: String): Map<String, Any?> {
		val state = createPartQueryNodeState()
		registerQueryInboundHandler(partpath, kind, { _, _ -> listOf(mapOf("id" to "r1")) }, state)
		val wire = PartMemoryWire()
		attachPartQueryWire(
			DefaultWireContext("alice"),
			wire,
			PartQueryDependencies(selectNeighbors = { emptyList() }, state = state),
		)

		wire.dispatch("part_query_req", request(requestId), "peer-a")
		awaitCondition { wire.sent.isNotEmpty() }
		@Suppress("UNCHECKED_CAST")
		return wire.sent[0].second as Map<String, Any?>
	}

	@Test
	fun `default signResponse signs with node identity and default verifyResponse accepts it`() = runBlocking {
		withTempNode("p2p-part-query-defaults-") {
			val response = collectSignedResponse("rv1")

			assertEquals(getNodeHash(), response["fromNodeHash"])
			assertEquals(128, (response["sig"] as String).length)
			assertEquals(64, (response["nodePubKey"] as String).length)

			val receiverState = createPartQueryNodeState()
			val accepted = OriginBag(maxHits = 8)
			receiverState.originBags["rv1"] = accepted
			handleIncomingPartQueryResponse(response, "peer-a", PartQueryDependencies(state = receiverState))

			assertEquals(1, accepted.entries.size)
			assertEquals(listOf(mapOf("id" to "r1")), accepted.entries[0].rows)
		}
	}

	@Test
	fun `default verifyResponse rejects tampered rows`() = runBlocking {
		withTempNode("p2p-part-query-tamper-") {
			val response = collectSignedResponse("rv2")
			val tampered = LinkedHashMap(response)
			tampered["rows"] = listOf(mapOf("evil" to true))

			val receiverState = createPartQueryNodeState()
			val bag = OriginBag(maxHits = 8)
			receiverState.originBags["rv2"] = bag
			handleIncomingPartQueryResponse(tampered, "peer-a", PartQueryDependencies(state = receiverState))

			assertTrue(bag.entries.isEmpty())
		}
	}

	@Test
	fun `default getNodeHash and selectQueryNeighbors use node identity and trust graph`() = runBlocking {
		withTempNode("p2p-part-query-neighbors-") {
			val knownA = "a1".repeat(32)
			val knownB = "b1".repeat(32)
			saveNetwork(NetworkData(mutableListOf(knownA, knownB), mutableListOf(), mutableListOf(), 0.0))

			val delivered = ArrayList<Pair<String, String>>()
			val state = createPartQueryNodeState()
			registerQueryInboundHandler(partpath, kind, { _, _ -> listOf(mapOf("id" to "local")) }, state)
			val result = queryNetwork(
				"default-deps-neighbors-user",
				partpath,
				kind,
				mapOf("q" to "x"),
				PartQueryQueryOptions(
					ttl = 1.0,
					timeoutMs = 150.0,
					dependencies = PartQueryDependencies(
						deliver = { target, action, _ ->
							delivered.add(target to action)
							true
						},
						state = state,
					),
				),
			)

			// 默认 getNodeHash 生效：本地 rows 来自本机 handler，且源节点为本机 hash。
			assertEquals(listOf(mapOf("id" to "local")), result.rows)
			assertEquals(setOf(knownA, knownB), delivered.map { it.first }.toSet())
			assertTrue(delivered.all { it.second == "part_query_req" })
		}
	}
}
