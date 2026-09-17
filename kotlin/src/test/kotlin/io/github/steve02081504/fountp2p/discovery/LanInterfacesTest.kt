package io.github.steve02081504.fountp2p.discovery

import org.junit.Assert.assertEquals
import org.junit.Test

/** 等价 `test/pure/lan_interfaces.test.mjs`。 */
class LanInterfacesTest {
	@Test
	fun `normalizeLanHosts accepts private and link local IPv4`() {
		assertEquals(listOf("192.168.1.5"), normalizeLanHosts(listOf("192.168.1.5")))
		assertEquals(listOf("10.0.0.1"), normalizeLanHosts(listOf("10.0.0.1")))
		assertEquals(listOf("172.16.0.1"), normalizeLanHosts(listOf("172.16.0.1")))
		assertEquals(listOf("172.31.255.254"), normalizeLanHosts(listOf("172.31.255.254")))
		assertEquals(listOf("169.254.10.20"), normalizeLanHosts(listOf("169.254.10.20")))
	}

	@Test
	fun `normalizeLanHosts rejects public loopback unspecified multicast and broadcast`() {
		for (host in listOf("8.8.8.8", "1.2.3.4", "127.0.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "172.32.0.1", "172.15.0.1"))
			assertEquals("should reject $host", emptyList<String>(), normalizeLanHosts(listOf(host)))
	}

	@Test
	fun `normalizeLanHosts rejects malformed input and out of range octets`() {
		for (host in listOf<Any?>("not-an-ip", "999.999.999.999", "192.168.1", "192.168.1.1.1", "", null)) {
			assertEquals("should reject ${host}", emptyList<String>(), normalizeLanHosts(listOf(host)))
		}
	}

	@Test
	fun `normalizeLanHosts dedupes and caps at MAX_LAN_HOSTS`() {
		val many = listOf("10.0.0.1", "10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4", "10.0.0.5")
		assertEquals(MAX_LAN_HOSTS, normalizeLanHosts(many).size)
		assertEquals(listOf("10.0.0.1"), normalizeLanHosts(listOf("10.0.0.1", "10.0.0.1")))
	}
}
