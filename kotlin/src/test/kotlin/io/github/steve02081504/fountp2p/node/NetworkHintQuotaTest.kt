package io.github.steve02081504.fountp2p.node

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 等价 `test/pure/network_hint_quota.test.mjs`。
 */
class NetworkHintQuotaTest {
	private val node = "a".repeat(64)

	@Test
	fun `capHintsBySource limits per-source hints`() {
		val hints = (0 until 20).map {
			NetworkHint(
				nodeHash = node,
				source = "pex:flood",
				kind = "pex",
				weight = 0.1,
				expiresAt = System.currentTimeMillis().toDouble() + 1e6,
			)
		}
		val capped = capHintsBySource(hints, 5)
		assertEquals(5, capped.size)
		assertEquals(true, capped.all { it.source == "pex:flood" })
	}

	@Test
	fun `normalizeNetwork still dedupes peers`() {
		val net = normalizeNetwork(
			mapOf(
				"trustedPeers" to listOf(node),
				"explorePeers" to emptyList<String>(),
				"hints" to emptyList<Any?>(),
			),
		)
		assertEquals(listOf(node), net.trustedPeers)
	}

	@Test
	fun `saveNetwork caps trustedPeers at 64`() = runBlocking {
		withTempNode("fount-p2p-trusted-cap-") {
			val hashes = (0 until 80).map { index ->
				index.toString(16).padStart(2, '0').repeat(32).substring(0, 64)
			}
			replaceNetworkPeerPools(mapOf("trustedPeers" to hashes, "explorePeers" to emptyList<String>()))
			assertEquals(64, loadNetwork().trustedPeers.size)
			promoteExplorePeer(node)
			assertEquals(64, loadNetwork().trustedPeers.size)
			assertEquals(true, loadNetwork().trustedPeers.contains(node))
		}
	}
}
