package io.github.steve02081504.fountp2p.wire.part

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test

/** 对应 `js/wire/part/pending.mjs` 的等价测试。 */
class PartPendingTest {
	@After
	fun cleanPending() {
		pendingPartInvoke.clear()
	}

	private fun envelope(requestId: String, value: Any?): Map<String, Any?> =
		mapOf("requestId" to requestId, "response" to mapOf("result" to value))

	@Test
	fun `handleIncomingPartInvokeResponse dedupes peers and finishes at maxResponses`() {
		val responses = mutableListOf<Any?>()
		var finishCount = 0
		pendingPartInvoke["r1"] = PendingPartInvoke(responses, { finishCount++ }, 2, mutableSetOf())

		handleIncomingPartInvokeResponse(envelope("r1", mapOf("from" to "peer-a")), "peer-a")
		handleIncomingPartInvokeResponse(envelope("r1", mapOf("from" to "peer-a")), "peer-a")
		assertEquals(1, responses.size)
		assertEquals(0, finishCount)

		handleIncomingPartInvokeResponse(envelope("r1", mapOf("from" to "peer-b")), "peer-b")
		assertEquals(2, responses.size)
		assertEquals(1, finishCount)
	}

	@Test
	fun `handleIncomingPartInvokeResponse ignores unknown ids and invalid responses`() {
		val responses = mutableListOf<Any?>()
		pendingPartInvoke["r1"] = PendingPartInvoke(responses, {}, 2, mutableSetOf())

		handleIncomingPartInvokeResponse(envelope("unknown", mapOf("from" to "peer-a")), "peer-a")
		handleIncomingPartInvokeResponse(
			mapOf("requestId" to "r1", "response" to mapOf("error" to mapOf("message" to "x"))),
			"peer-a",
		)
		assertEquals(0, responses.size)
	}
}
