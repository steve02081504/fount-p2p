package io.github.steve02081504.fountp2p.trust_graph

import io.github.steve02081504.fountp2p.node.bumpLocalDataRevision
import io.github.steve02081504.fountp2p.node.resetLocalDataRevisionForTests
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Before
import org.junit.Test

/**
 * `trust_graph/cache.mjs`（无独立 JS 测试）的行为覆盖：
 * TTL、显式失效、local_data_revision 联动与按 username 分桶。
 */
class CacheTest {
	@Before
	fun setUp() {
		resetLocalDataRevisionForTests()
		invalidateTrustGraphCache()
	}

	@After
	fun tearDown() {
		invalidateTrustGraphCache()
		resetLocalDataRevisionForTests()
	}

	private fun graphOf(vararg nodes: String): Map<String, TrustNode> =
		LinkedHashMap<String, TrustNode>().apply {
			for (node in nodes) put(node, TrustNode(node, 1.0, listOf("network")))
		}

	@Test
	fun `getCachedTrustGraph reuses cached graph within ttl`() = runBlocking {
		var builds = 0
		val first = getCachedTrustGraph("u", { builds++; graphOf("a".repeat(64)) })
		val second = getCachedTrustGraph("u", { builds++; graphOf("b".repeat(64)) })
		assertEquals(1, builds)
		assertSame(first, second)
	}

	@Test
	fun `getCachedTrustGraph rebuilds after ttl expiry`() = runBlocking {
		var builds = 0
		getCachedTrustGraph("u", { builds++; graphOf("a".repeat(64)) }, 0.0)
		getCachedTrustGraph("u", { builds++; graphOf("a".repeat(64)) }, 0.0)
		assertEquals(2, builds)
	}

	@Test
	fun `invalidateTrustGraphCache forces rebuild`() = runBlocking {
		var builds = 0
		getCachedTrustGraph("u", { builds++; graphOf("a".repeat(64)) })
		invalidateTrustGraphCache()
		getCachedTrustGraph("u", { builds++; graphOf("a".repeat(64)) })
		assertEquals(2, builds)
	}

	@Test
	fun `getCachedTrustGraph rebuilds when local data revision changes`() = runBlocking {
		var builds = 0
		getCachedTrustGraph("u", { builds++; graphOf("a".repeat(64)) })
		bumpLocalDataRevision()
		getCachedTrustGraph("u", { builds++; graphOf("a".repeat(64)) })
		assertEquals(2, builds)
	}

	@Test
	fun `cache is keyed by username`() = runBlocking {
		var builds = 0
		getCachedTrustGraph("u1", { builds++; graphOf("a".repeat(64)) })
		getCachedTrustGraph("u2", { builds++; graphOf("b".repeat(64)) })
		getCachedTrustGraph("u1", { builds++; graphOf("c".repeat(64)) })
		assertEquals(2, builds)
	}
}
