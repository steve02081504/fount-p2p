package io.github.steve02081504.fountp2p.trust_graph

import org.junit.Assert.assertEquals
import org.junit.Test

/** 等价 `test/pure/trust_graph_engine.test.mjs`。 */
class EngineTest {
	@Test
	fun `hint only node gets attenuated lift`() {
		val node = "a".repeat(64)
		val hints = (0 until 20).map { i -> TrustHint(nodeHash = node, source = "s$i", weight = 1.0) }
		val graph = mergeGraph(TrustGraphInputs(hints = hints, scoreOf = { 0.0 }))
		val score = graph[node]?.score ?: 0.0
		assertEquals(true, score > 0)
		assertEquals(true, score < TrustGraphTunables.hintMaxBonus)
	}

	@Test
	fun `hints cannot inflate beyond bounded bonus over hard evidence`() {
		val node = "b".repeat(64)
		val hints = (0 until 30).map { i -> TrustHint(nodeHash = node, source = "poison-$i", weight = 2.0) }
		val graph = mergeGraph(
			TrustGraphInputs(trustedPeers = listOf(node), hints = hints, scoreOf = { 0.2 }),
		)
		val score = graph[node]?.score ?: 0.0
		assertEquals(true, score >= 0.2)
		assertEquals(true, score <= 0.2 + TrustGraphTunables.hintMaxBonus + 1e-9)
	}
}
