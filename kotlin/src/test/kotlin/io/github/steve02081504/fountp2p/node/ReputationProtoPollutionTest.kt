package io.github.steve02081504.fountp2p.node

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 等价 `test/integration/reputation_proto_pollution.test.mjs`。
 *
 * Kotlin/JVM 无 JS 原型链，`__proto__` 只是普通 Map 键；这里验证危险键不会破坏
 * 其他节点查询（无污染等价断言）。
 */
class ReputationProtoPollutionTest {
	private val peer = "e".repeat(64)
	private val protoKey = "__proto__"

	@Test
	fun `unvalidated proto peer key cannot pollute other lookups`() = runBlocking {
		withTempNode("fount-rep-proto-") {
			recordMessageRateViolation(protoKey, 1.0)
			observePeerBehavior(protoKey, 5.0)
			assertEquals(0.0, pickNodeScore(peer), 0.0)
			@Suppress("UNCHECKED_CAST")
			val byNodeHash = loadReputation()["byNodeHash"] as Map<String, Any?>
			assertEquals(true, byNodeHash.containsKey(protoKey))
			assertEquals(null, byNodeHash[peer])
		}
	}

	@Test
	fun `legitimate hex peer key still updates its own reputation row`() = runBlocking {
		withTempNode("fount-rep-proto-ok-") {
			recordMessageRateViolation(peer, 1.0)
			@Suppress("UNCHECKED_CAST")
			val byNodeHash = loadReputation()["byNodeHash"] as Map<String, Any?>
			val row = byNodeHash[peer] as? Map<*, *>
			assertEquals(true, row != null)
			assertEquals(true, (row!!["score"] as Number).toDouble() < 0.0)
		}
	}
}
