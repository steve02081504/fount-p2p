package io.github.steve02081504.fountp2p.node

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** `node/routing_profile.mjs` 的等价测试。 */
class RoutingProfileTest {
	@Test
	fun `default profile and low profile roundtrip`() = runBlocking {
		withTempNode("p2p-routing-profile-") {
			assertEquals("default", getRoutingProfile())

			assertEquals("low", setRoutingProfile("low"))
			assertEquals("low", getRoutingProfile())
			assertTrue(getNodeTransportSettings()["batterySaver"] == true)

			assertEquals("default", setRoutingProfile("default"))
			assertEquals("default", getRoutingProfile())
			assertTrue(getNodeTransportSettings()["batterySaver"] == false)
		}
	}

	@Test
	fun `unknown profile is rejected`() = runBlocking {
		withTempNode("p2p-routing-profile-bad-") {
			val error = assertThrows(IllegalArgumentException::class.java) { setRoutingProfile("turbo") }
			assertEquals("p2p: setRoutingProfile expects default|low", error.message)
			assertEquals("default", getRoutingProfile())
		}
	}
}
