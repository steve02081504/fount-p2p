package io.github.steve02081504.fountp2p.transport

import io.github.steve02081504.fountp2p.registries.RosterPeer
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 等价 `test/pure/stale_peer_log.test.mjs`。
 */
class StalePeerLogTest {
	@Test
	fun `recordStalePeerPrune accumulates per scope and retains recent entries`() {
		val scope = "test-scope-${System.currentTimeMillis()}"
		recordStalePeerPrune(
			scope,
			listOf(
				RosterPeer("p1", "a".repeat(64)),
				RosterPeer("p2", "b".repeat(64)),
			),
		)
		assertEquals(2.0, getStalePeerPruneCount(scope), 0.0)
		val recent = getRecentStalePeerPrunes()
		assertEquals(true, recent.any { it["scope"] == scope && it["peerId"] == "p1" })
	}

	@Test
	fun `recordStalePeerPrune ignores empty batches`() {
		val scope = "empty-scope-${System.currentTimeMillis()}"
		recordStalePeerPrune(scope, emptyList())
		assertEquals(0.0, getStalePeerPruneCount(scope), 0.0)
	}
}
