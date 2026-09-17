package io.github.steve02081504.fountp2p.mailbox

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.wire.DefaultWireContext
import io.github.steve02081504.fountp2p.wire.WireAdapter
import io.github.steve02081504.fountp2p.wire.WireHandler
import io.github.steve02081504.fountp2p.wire.WireContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * `mailbox/wire.mjs` 的等价覆盖：解析失败不派发、成功派发到注入的 [MailboxWireHandlers]。
 *
 * JS 直接调用 `deliver_or_store.mjs`；Kotlin 侧因 transport 未移植改为注入（见 [MailboxWireHandlers]）。
 */
class MailboxWireTest {
	private val recipient = "a".repeat(64)

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

	private class RecordingHandlers : MailboxWireHandlers {
		var put: Map<String, Any?>? = null
		var give: Map<String, Any?>? = null
		var wantSend: ((Any?, String) -> Unit)? = null

		override fun ingestMailboxPut(wireContext: WireContext, put: Map<String, Any?>, peerId: String) {
			this.put = put
		}

		override fun respondMailboxWant(
			want: Map<String, Any?>,
			sendGive: (payload: Any?, peerId: String) -> Unit,
			peerId: String,
		) {
			this.wantSend = sendGive
		}

		override fun ingestMailboxGive(wireContext: WireContext, give: Map<String, Any?>) {
			this.give = give
		}
	}

	@Test
	fun `attachMailboxWire parses and dispatches valid payloads`() {
		val wire = MemoryWire()
		val handlers = RecordingHandlers()
		val dispose = attachMailboxWire(DefaultWireContext("u"), wire, handlers)
		assertEquals(3, wire.handlers.size)

		wire.handlers["mailbox_put"]!!.forEach { it("nope", "peer") }
		assertNull(handlers.put)
		wire.handlers["mailbox_put"]!!.forEach {
			it(mapOf<String, Any?>("record" to mapOf<String, Any?>("toPubKeyHash" to recipient)), "peer")
		}
		assertNotNull(handlers.put)
		assertEquals(recipient, Json.at(Json.at(handlers.put, "record"), "toPubKeyHash"))

		wire.handlers["mailbox_want"]!!.forEach { it(mapOf("toPubKeyHash" to "bad"), "peer") }
		assertNull(handlers.wantSend)
		wire.handlers["mailbox_want"]!!.forEach { it(mapOf("toPubKeyHash" to recipient), "peer-1") }
		assertNotNull(handlers.wantSend)
		handlers.wantSend!!.invoke(mapOf("records" to emptyList<Any?>()), "target")
		assertEquals("mailbox_give", wire.sent[0].first)
		assertEquals("target", wire.sent[0].third)

		wire.handlers["mailbox_give"]!!.forEach { it("nope", "peer") }
		assertNull(handlers.give)
		wire.handlers["mailbox_give"]!!.forEach {
			it(
				mapOf<String, Any?>(
					"records" to listOf(
						mapOf<String, Any?>(
							"toPubKeyHash" to recipient,
							"app" to "chat",
							"envelope" to mapOf<String, Any?>("id" to "e1"),
						),
					),
				),
				"peer",
			)
		}
		assertNotNull(handlers.give)

		dispose()
		assertEquals(0, wire.handlers.values.sumOf { it.size })
	}
}
