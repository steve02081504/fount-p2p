package io.github.steve02081504.fountp2p.wire

import org.junit.Assert.assertEquals
import org.junit.Test

/** 对应 `js/wire/subscribe.mjs` 的等价测试。 */
class SubscribeTest {
	private class MemoryWire : WireAdapter {
		val handlers = LinkedHashMap<String, MutableSet<WireHandler>>()
		val sent = mutableListOf<Triple<String, Any?, String?>>()

		override fun on(name: String, handler: WireHandler): () -> Unit {
			val set = handlers.getOrPut(name) { linkedSetOf() }
			set.add(handler)
			return { set.remove(handler) }
		}

		override fun send(name: String, payload: Any?, peerId: String?) {
			sent.add(Triple(name, payload, peerId))
		}
	}

	@Test
	fun `subscribeWire registers every handler and dispose removes them`() {
		val wire = MemoryWire()
		var calls = 0
		val dispose = subscribeWire(
			wire,
			mapOf<String, WireHandler>("a" to { _, _ -> calls++ }),
		)
		assertEquals(1, wire.handlers["a"]?.size)
		for (handler in wire.handlers["a"]!!) handler(null, "peer")
		assertEquals(1, calls)
		dispose()
		assertEquals(0, wire.handlers["a"]?.size)
	}
}
