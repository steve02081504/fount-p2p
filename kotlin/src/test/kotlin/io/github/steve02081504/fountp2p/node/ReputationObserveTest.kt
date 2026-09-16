package io.github.steve02081504.fountp2p.node

import io.github.steve02081504.fountp2p.reputation.isQuarantinedPure
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 等价 `test/integration/reputation_observe.test.mjs`。
 */
class ReputationObserveTest {
	private val peer = "c".repeat(64)

	@Test
	fun `observePeerBehavior awaits reputation mutation before returning`() = runBlocking {
		withTempNode("fount-rep-") {
			for (i in 0 until 6) observePeerBehavior(peer, 0.05)

			val anomaly = observePeerBehavior(peer, 5.0)
			assertEquals(true, anomaly)
			assertEquals(true, isQuarantinedPure(loadReputation(), peer))
		}
	}
}
