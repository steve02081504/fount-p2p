package io.github.steve02081504.fountp2p.wire.part

import io.github.steve02081504.fountp2p.node.withTempNode
import io.github.steve02081504.fountp2p.trust_graph.DEFAULT_TRUST_GRAPH_OWNER
import io.github.steve02081504.fountp2p.trust_graph.TrustGraphProvider
import io.github.steve02081504.fountp2p.trust_graph.TrustNode
import io.github.steve02081504.fountp2p.trust_graph.clearTrustGraphProvider
import io.github.steve02081504.fountp2p.trust_graph.registerTrustGraphProvider
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** `wire/part/fanout.mjs` 的 `collectPartInvokeResponses` 等价测试。 */
class PartFanoutTest {
	private val repliedRequestIds = ArrayList<String>()

	/**
	 * @param onFanout fanoutToTopNodes 行为：返回发出的请求数
	 * @return 记录 send 的 provider
	 */
	private fun provider(onFanout: suspend (Map<String, Any?>, Int?) -> Int): TrustGraphProvider =
		object : TrustGraphProvider {
			override suspend fun buildMergedGraph(username: String): Map<String, TrustNode> = emptyMap()

			override suspend fun pickTopNodes(username: String, limit: Int): List<TrustNode> = emptyList()

			override suspend fun sendToNode(
				username: String,
				targetNodeHash: String,
				actionName: String,
				payload: Any?,
				graph: Map<String, TrustNode>?,
			): Boolean = false

			override suspend fun fanoutToTopNodes(
				username: String,
				actionName: String,
				payload: Any?,
				limit: Int?,
			): Int {
				assertEquals("part_invoke", actionName)
				if (payload !is Map<*, *>) return 0
				@Suppress("UNCHECKED_CAST")
				return onFanout(payload as Map<String, Any?>, limit)
			}
		}

	@After
	fun cleanup() {
		clearTrustGraphProvider()
		pendingPartInvoke.clear()
	}

	@Test
	fun `collectPartInvokeResponses gathers neighbor replies until maxResponses`() = runBlocking {
		withTempNode("p2p-part-fanout-") {
			registerTrustGraphProvider(
				DEFAULT_TRUST_GRAPH_OWNER,
				provider { payload, limit ->
					assertEquals(2, limit)
					val requestId = payload["requestId"] as String
					repliedRequestIds.add(requestId)
					// 模拟邻居回包（attachPartWire 的收集路径）
					handleIncomingPartInvokeResponse(
						mapOf("requestId" to requestId, "response" to mapOf("result" to mapOf("from" to "peer-a"))),
						"peer-a",
					)
					handleIncomingPartInvokeResponse(
						mapOf("requestId" to requestId, "response" to mapOf("result" to mapOf("from" to "peer-b"))),
						"peer-b",
					)
					2
				},
			)

			val replies = collectPartInvokeResponses("alice", "shells/social", mapOf("kind" to "ping"), 1000, 2)

			assertEquals(2, replies.size)
			assertEquals(listOf(mapOf("from" to "peer-a"), mapOf("from" to "peer-b")), partInvokeDataRows(replies))
			assertEquals(emptyList<String>(), partInvokeErrorMessages(replies))
			assertTrue(repliedRequestIds.isNotEmpty())
			assertTrue(pendingPartInvoke.isEmpty())
		}
	}

	@Test
	fun `collectPartInvokeResponses finishes immediately when fanout sends zero`() = runBlocking {
		withTempNode("p2p-part-fanout-zero-") {
			registerTrustGraphProvider(DEFAULT_TRUST_GRAPH_OWNER, provider { _, _ -> 0 })

			val started = System.currentTimeMillis()
			val replies = collectPartInvokeResponses("alice", "shells/cabinet", mapOf("kind" to "pull"), 5000)
			val elapsed = System.currentTimeMillis() - started

			assertEquals(emptyList<Any?>(), replies)
			assertTrue("expected immediate settle, took ${elapsed}ms", elapsed < 1000)
			assertTrue(pendingPartInvoke.isEmpty())
		}
	}

	@Test
	fun `collectPartInvokeResponses respects timeoutMs even when fanout hangs`() = runBlocking {
		withTempNode("p2p-part-fanout-hang-") {
			registerTrustGraphProvider(DEFAULT_TRUST_GRAPH_OWNER, provider { _, _ -> awaitCancellation() })

			val started = System.currentTimeMillis()
			val replies = collectPartInvokeResponses("alice", "shells/social", mapOf("kind" to "list"), 80, 2)
			val elapsed = System.currentTimeMillis() - started

			assertEquals(emptyList<Any?>(), replies)
			assertTrue("expected end-to-end bound by timeoutMs, took ${elapsed}ms", elapsed < 1000)
			assertTrue(pendingPartInvoke.isEmpty())
		}
	}

	@Test
	fun `collectPartInvokeResponses separates error replies`() = runBlocking {
		withTempNode("p2p-part-fanout-err-") {
			registerTrustGraphProvider(
				DEFAULT_TRUST_GRAPH_OWNER,
				provider { payload, _ ->
					val requestId = payload["requestId"] as String
					handleIncomingPartInvokeResponse(
						mapOf("requestId" to requestId, "response" to mapOf("result" to mapOf("ok" to true))),
						"peer-a",
					)
					handleIncomingPartInvokeResponse(
						mapOf(
							"requestId" to requestId,
							"response" to mapOf("error" to mapOf("message" to "nope", "code" to "NOPE")),
						),
						"peer-b",
					)
					2
				},
			)

			val replies = collectPartInvokeResponses("alice", "shells/social", mapOf("kind" to "ping"), 1000, 2)

			assertEquals(listOf(mapOf("ok" to true)), partInvokeDataRows(replies))
			assertEquals(listOf("nope"), partInvokeErrorMessages(replies))
			assertEquals(2, replies.size)
		}
	}
}
