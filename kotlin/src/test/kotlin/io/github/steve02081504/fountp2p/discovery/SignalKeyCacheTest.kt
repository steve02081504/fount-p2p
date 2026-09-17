package io.github.steve02081504.fountp2p.discovery

import io.github.steve02081504.fountp2p.discovery.internal.SIGNAL_KEY_CACHE_MAX
import io.github.steve02081504.fountp2p.discovery.internal.decryptSignalPacket
import io.github.steve02081504.fountp2p.discovery.internal.encryptSignalPacket
import io.github.steve02081504.fountp2p.discovery.internal.signalKeyCacheSize
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** 等价 `test/pure/signal_key_cache.test.mjs`。 */
class SignalKeyCacheTest {
	@Test
	fun `signal key cache is bounded by rendezvous key churn`() {
		val before = signalKeyCacheSize()
		for (i in 0 until SIGNAL_KEY_CACHE_MAX + 80) {
			val key = "rdv-churn-$i-${java.lang.Long.toString(System.nanoTime(), 16)}"
			val bytes = encryptSignalPacket(key, mapOf("i" to i.toDouble()))
			assertEquals(i.toDouble(), decryptSignalPacket(key, bytes)?.get("i"))
		}
		assertTrue(signalKeyCacheSize() <= SIGNAL_KEY_CACHE_MAX)
		assertTrue(signalKeyCacheSize() >= minOf(SIGNAL_KEY_CACHE_MAX, before))
	}
}
