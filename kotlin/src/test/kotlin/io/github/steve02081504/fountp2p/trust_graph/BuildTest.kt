package io.github.steve02081504.fountp2p.trust_graph

import io.github.steve02081504.fountp2p.node.NetworkData
import io.github.steve02081504.fountp2p.node.loadReputation
import io.github.steve02081504.fountp2p.node.saveDenylist
import io.github.steve02081504.fountp2p.node.saveNetwork
import io.github.steve02081504.fountp2p.node.saveReputation
import io.github.steve02081504.fountp2p.node.withTempNode
import io.github.steve02081504.fountp2p.registries.FederationRoomSlot
import io.github.steve02081504.fountp2p.registries.RosterPeer
import io.github.steve02081504.fountp2p.registries.registerFederationRoomProvider
import io.github.steve02081504.fountp2p.registries.unregisterFederationRoomProvider
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `trust_graph/build.mjs`（无独立 JS 测试）的行为覆盖：
 * network/reputation/denylist 合并、名册折入、隔离剔除与缓存联动。
 */
class BuildTest {
	private fun setNetwork(vararg peers: String) {
		saveNetwork(
			NetworkData(
				trustedPeers = peers.toMutableList(),
				explorePeers = mutableListOf(),
				hints = mutableListOf(),
				lastRosterAt = 0.0,
			),
		)
	}

	private fun setScores(vararg entries: Pair<String, Any?>) {
		val rep = loadReputation()
		val byNode = LinkedHashMap<String, Any?>()
		for ((node, row) in entries) byNode[node] = row
		rep["byNodeHash"] = byNode
		saveReputation(rep)
	}

	private fun registerRoom(ownerId: String, groupId: String, vararg remoteNodeHashes: String) {
		registerFederationRoomProvider(ownerId) { _ ->
			listOf(
				FederationRoomSlot(
					groupId = groupId,
					getRoster = { remoteNodeHashes.map { RosterPeer("p:$it", it) } },
					getPeerIdByNodeHash = { null },
					sendToPeer = { _, _, _ -> },
				),
			)
		}
	}

	@Test
	fun `buildMergedGraph merges network peers and caches result`() = runBlocking {
		withTempNode("fount-tg-build-") {
			invalidateTrustGraphCache()
			val a = "a".repeat(64)
			val b = "b".repeat(64)
			setNetwork(a, b)
			setScores(a to linkedMapOf("score" to 0.7), b to linkedMapOf("score" to 0.25))

			val first = buildMergedGraph("u")
			assertTrue(first.containsKey(a))
			assertTrue(first.containsKey(b))
			assertEquals(0.7, first[a]!!.score, 1e-9)
			assertEquals(0.25, first[b]!!.score, 1e-9)

			assertSame(first, buildMergedGraph("u"))
		}
	}

	@Test
	fun `pickTopNodes sorts by score and drops quarantined nodes`() = runBlocking {
		withTempNode("fount-tg-top-") {
			invalidateTrustGraphCache()
			val a = "a".repeat(64)
			val b = "b".repeat(64)
			val q = "c".repeat(64)
			setNetwork(a, b, q)
			val now = System.currentTimeMillis().toDouble()
			setScores(
				a to linkedMapOf("score" to 0.2),
				b to linkedMapOf("score" to 0.9),
				q to linkedMapOf("score" to 5.0, "quarantinedUntil" to now + 1_000_000.0),
			)

			assertEquals(listOf(b, a), pickTopNodes("u").map { it.nodeHash })
		}
	}

	@Test
	fun `buildMergedGraph drops denylisted nodes`() = runBlocking {
		withTempNode("fount-tg-deny-") {
			invalidateTrustGraphCache()
			val a = "a".repeat(64)
			val b = "b".repeat(64)
			setNetwork(a, b)
			saveDenylist(linkedMapOf("blocked" to listOf(mapOf("scope" to "node", "value" to a))))
			try {
				val graph = buildMergedGraph("u")
				assertEquals(false, graph.containsKey(a))
				assertTrue(graph.containsKey(b))
			}
			finally {
				saveDenylist(linkedMapOf("blocked" to emptyList<Any?>()))
			}
		}
	}

	@Test
	fun `buildMergedGraph folds federation room rosters with local scores`() = runBlocking {
		withTempNode("fount-tg-roster-") {
			invalidateTrustGraphCache()
			val a = "a".repeat(64)
			setScores(a to linkedMapOf("score" to 0.42))
			registerRoom("trust-graph-test", "g1", a)
			try {
				val graph = buildMergedGraph("u")
				assertTrue(graph.containsKey(a))
				assertEquals(0.42, graph[a]!!.score, 1e-9)
				assertEquals(listOf("g1"), graph[a]!!.scopeIds)
			}
			finally {
				unregisterFederationRoomProvider("trust-graph-test")
			}
		}
	}

	@Test
	fun `buildMergedGraph skips quarantined roster peers`() = runBlocking {
		withTempNode("fount-tg-roster-q-") {
			invalidateTrustGraphCache()
			val a = "a".repeat(64)
			val now = System.currentTimeMillis().toDouble()
			setScores(a to linkedMapOf("score" to 0.5, "quarantinedUntil" to now + 1_000_000.0))
			registerRoom("trust-graph-test-q", "g1", a)
			try {
				assertEquals(false, buildMergedGraph("u").containsKey(a))
			}
			finally {
				unregisterFederationRoomProvider("trust-graph-test-q")
			}
		}
	}
}
