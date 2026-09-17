package io.github.steve02081504.fountp2p.files

import io.github.steve02081504.fountp2p.node.NetworkData
import io.github.steve02081504.fountp2p.node.saveNetwork
import io.github.steve02081504.fountp2p.node.withTempNode
import io.github.steve02081504.fountp2p.trust_graph.DEFAULT_TRUST_GRAPH_OWNER
import io.github.steve02081504.fountp2p.trust_graph.clearTrustGraphProvider
import io.github.steve02081504.fountp2p.trust_graph.registerTrustGraphProvider
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 等价 `js/test/pure/fetch_fanout.test.mjs`（`fetch_fanout.mjs` 的传输子集见 [fanoutFedFetch] KDoc）。
 */
class FedFanoutTest {
	@Test
	fun `fanoutFedFetch with targets sends only to unique valid targets, no node-scope fanout`() = runBlocking {
		withTempNode("fount-fetch-fanout-tgt-") {
			val mock = MockTrustGraph()
			registerTrustGraphProvider(DEFAULT_TRUST_GRAPH_OWNER, mock.provider)
			try {
				val firstTargetNodeHash = "a".repeat(64)
				val secondTargetNodeHash = "b".repeat(64)
				val payload = mapOf("requestId" to "r1", "nodeHash" to "self")
				fanoutFedFetch(
					"u",
					"fed_manifest_get",
					payload,
					listOf(firstTargetNodeHash, secondTargetNodeHash, secondTargetNodeHash, "invalid", ""),
				)
				assertEquals(2, mock.sent.size)
				assertEquals(firstTargetNodeHash, mock.sent[0])
				assertEquals(secondTargetNodeHash, mock.sent[1])
				assertEquals(0, mock.fanouts.size)
			}
			finally {
				clearTrustGraphProvider()
			}
		}
	}

	@Test
	fun `fanoutFedFetch without targets keeps node-scope fanoutToTopNodes`() = runBlocking {
		withTempNode("fount-fetch-fanout-scope-") {
			val mock = MockTrustGraph()
			registerTrustGraphProvider(DEFAULT_TRUST_GRAPH_OWNER, mock.provider)
			try {
				val payload = mapOf("requestId" to "r2", "nodeHash" to "self")
				fanoutFedFetch("u", "fed_manifest_get", payload)
				assertEquals(1, mock.fanouts.size)
				assertEquals("fed_manifest_get", mock.fanouts[0])
				@Suppress("UNCHECKED_CAST")
				val sentPayload = mock.fanoutPayloads[0] as Map<String, Any?>
				assertEquals("r2", sentPayload["requestId"])
			}
			finally {
				clearTrustGraphProvider()
			}
		}
	}

	@Test
	fun `fanoutFedFetch with invalid-only targets sends nothing, no node-scope fanout`() = runBlocking {
		withTempNode("fount-fetch-fanout-invalid-") {
			val mock = MockTrustGraph()
			registerTrustGraphProvider(DEFAULT_TRUST_GRAPH_OWNER, mock.provider)
			try {
				val payload = mapOf("requestId" to "r3", "nodeHash" to "self")
				fanoutFedFetch("u", "fed_manifest_get", payload, listOf("not-hex", "", "0x" + "a".repeat(64)))
				assertEquals(0, mock.sent.size)
				assertEquals(0, mock.fanouts.size)
			}
			finally {
				clearTrustGraphProvider()
			}
		}
	}

	@Test
	fun `fanoutFedFetch without targets sends to known peers immediately, node-scope fanout not gated behind dialing`() = runBlocking {
		withTempNode("fount-fetch-fanout-known-") {
			val mock = MockTrustGraph()
			registerTrustGraphProvider(DEFAULT_TRUST_GRAPH_OWNER, mock.provider)
			try {
				// 注入已知 peer 池：非定向 fanout 应向其 sendToNode，且不因拨号（此处 mock 全部可达）阻塞 node-scope fanout。
				val knownPeerA = "a1".repeat(32)
				val knownPeerB = "b1".repeat(32)
				saveNetwork(NetworkData(mutableListOf(knownPeerA, knownPeerB), mutableListOf(), mutableListOf(), 0.0))

				val payload = mapOf("requestId" to "r4", "nodeHash" to "self")
				fanoutFedFetch("u", "fed_chunk_get", payload)
				// 已知 peers 均已投递（mock sendToNode 返回 true → 视为群房间/直连可达，无需拨号）
				assertEquals(2, mock.sent.size)
				assertEquals(knownPeerA, mock.sent[0])
				assertEquals(knownPeerB, mock.sent[1])
				// node-scope top-K fanout 照常执行（不受已知 peer 投递影响）
				assertEquals(1, mock.fanouts.size)
				assertEquals("fed_chunk_get", mock.fanouts[0])
			}
			finally {
				clearTrustGraphProvider()
			}
		}
	}
}
