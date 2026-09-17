package io.github.steve02081504.fountp2p.transport

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 等价 `js/test/pure/signal_backlog.test.mjs`。
 */
class SignalBacklogTest {
	@Test
	fun `buffered signal session caps backlog without handlers`() {
		val session = BufferedSignalSession { }
		for (i in 0 until 200) session.deliver(mapOf("i" to i.toDouble()))
		val received = ArrayList<Any?>()
		session.onRemote { message -> received.add(message) }
		assertEquals(64, received.size)
		assertEquals(mapOf("i" to 136.0), received[0])
		assertEquals(mapOf("i" to 199.0), received[63])
	}
}
