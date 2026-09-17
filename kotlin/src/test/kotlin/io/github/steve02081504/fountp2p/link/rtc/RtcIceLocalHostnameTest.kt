package io.github.steve02081504.fountp2p.link.rtc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** 等价 `test/pure/rtc_ice_local_hostname.test.mjs`。 */
class RtcIceLocalHostnameTest {
	@Test
	fun `applyIceLocalHostnamePolicy drop rewrite none`() {
		val local = "candidate:1 1 udp 2130706431 host.local 54321 typ host generation 0"
		assertEquals(local, applyIceLocalHostnamePolicy(local, "none"))
		assertNull(applyIceLocalHostnamePolicy(local, "drop"))
		assertTrue(applyIceLocalHostnamePolicy(local, "rewrite-loopback")!!.contains("127.0.0.1"))
	}

	@Test
	fun `filterIceLocalHostnameCandidate returns null when dropped`() {
		val candidate = RtcIceCandidate(
			"candidate:1 1 udp 2130706431 host.local 54321 typ host",
			"0",
			0,
		)
		assertNull(filterIceLocalHostnameCandidate(candidate, "drop"))
	}

	@Test
	fun `W3C wrap drops local host before listeners see it`() {
		val peerConnection = IceLocalHostnameFilteredRtcPeerConnection("drop")
		val seen = ArrayList<Any?>()
		val onIceCandidate: (RtcIceCandidateEvent) -> Unit = { seen.add(it) }
		peerConnection.onIceCandidate = onIceCandidate
		assertSame(onIceCandidate, peerConnection.onIceCandidate)
		peerConnection.addEventListener("icecandidate") { seen.add(listOf("listener", it)) }
		peerConnection.emitIce(RtcIceCandidate("candidate:1 1 udp 2130706431 host.local 54321 typ host"))
		peerConnection.emitIce(RtcIceCandidate("candidate:2 1 udp 2130706431 10.0.0.1 54321 typ host"))
		peerConnection.emitIce(null)
		assertEquals(4, seen.size)
		assertTrue((seen[0] as RtcIceCandidateEvent).candidate!!.candidate!!.contains("10.0.0.1"))
		@Suppress("UNCHECKED_CAST")
		val listenerEvent = (seen[1] as List<Any?>)[1] as RtcIceCandidateEvent
		assertTrue(listenerEvent.candidate!!.candidate!!.contains("10.0.0.1"))
		assertNull((seen[2] as RtcIceCandidateEvent).candidate)
		@Suppress("UNCHECKED_CAST")
		val nullListenerEvent = (seen[3] as List<Any?>)[1] as RtcIceCandidateEvent
		assertNull(nullListenerEvent.candidate)
	}

	@Test
	fun `W3C wrap rewrite loopback only dispatches rewritten candidate`() {
		val peerConnection = IceLocalHostnameFilteredRtcPeerConnection("rewrite-loopback")
		val seen = ArrayList<String?>()
		peerConnection.addEventListener("icecandidate") { event ->
			seen.add(event.candidate?.candidate)
		}
		peerConnection.emitIce(RtcIceCandidate("candidate:1 1 udp 2130706431 host.local 54321 typ host"))
		assertEquals(1, seen.size)
		assertTrue(seen[0]!!.contains("127.0.0.1"))
		assertEquals(false, seen[0]!!.contains(".local"))
	}
}
