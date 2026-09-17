package io.github.steve02081504.fountp2p.transport

import kotlin.math.floor
import kotlin.math.max
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 等价 `test/pure/rtc_connection_budget.test.mjs`。
 */
class RtcConnectionBudgetTest {
	private val limits: Map<String, Any?> = mapOf(
		"maxActive" to 8.0,
		"maxJoinsPerMin" to 120.0,
		"trustedPeers" to listOf("trusted-node"),
	)

	@Test
	fun `single source cannot fill all rtc slots`() {
		val room = "room-source-cap"
		val sourceCap = max(1.0, floor(8.0 * 0.25)).toInt()
		for (i in 0 until sourceCap)
			assertEquals(true, takeRtcJoinSlot(room, "p$i", limits, "sybil-source"))
		assertEquals(false, takeRtcJoinSlot(room, "p-extra", limits, "sybil-source"))
		for (i in 0 until sourceCap) releaseRtcPeer(room, "p$i")
	}

	@Test
	fun `trusted peer annotated after identity keeps slot under load`() {
		val room = "room-trusted"
		val trustedPeer = "peer-trusted"
		for (i in 0 until 7)
			takeRtcJoinSlot(room, "fill$i", limits, "src$i")
		takeRtcJoinSlot(room, trustedPeer, limits, "sybil-source")
		annotateRtcPeerNodeHash(room, trustedPeer, "trusted-node", limits)
		assertEquals(true, takeRtcJoinSlot(room, trustedPeer, limits, "sybil-source"))
		releaseRtcPeer(room, trustedPeer)
	}

	@Test
	fun `empty rtc budget room bucket is dropped`() {
		val room = "room-drop-${System.currentTimeMillis()}"
		val before = rtcBudgetRoomCount()
		assertEquals(true, takeRtcJoinSlot(room, "only", limits, "src"))
		assertEquals(true, rtcBudgetRoomCount() >= before + 1)
		releaseRtcPeer(room, "only")
		assertEquals(before, rtcBudgetRoomCount())
	}
}
