package io.github.steve02081504.fountp2p.reputation

import org.junit.Assert.assertEquals
import org.junit.Test

/** 等价 `test/pure/reputation_anomaly_pure.test.mjs`。 */
class ReputationAnomalyPureTest {
	@Test
	fun `observeBehaviorSamplePure triggers quarantine after baseline drift`() {
		val data = newRepFile()
		val peer = "b".repeat(64)
		val tunables = LinkedHashMap(defaultReputationTunables()).apply {
			put("baselineMinSamples", 4.0)
			put("anomalyZThreshold", 1.5)
		}
		for (i in 0 until 6)
			observeBehaviorSamplePure(data, peer, 0.05, 1000.0 + i, tunables)
		val anomaly = observeBehaviorSamplePure(data, peer, 2.5, 2000.0, tunables).anomaly
		assertEquals(true, anomaly)
		assertEquals(true, isQuarantinedPure(data, peer, 2000.0))
	}
}
