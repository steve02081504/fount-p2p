package io.github.steve02081504.fountp2p.wire.part

import io.github.steve02081504.fountp2p.awaitCondition
import io.github.steve02081504.fountp2p.registries.InboundContext
import io.github.steve02081504.fountp2p.registries.dispatchDeliveryInbound
import io.github.steve02081504.fountp2p.registries.dispatchRpcInbound
import io.github.steve02081504.fountp2p.registries.registerDeliveryInboundHandler
import io.github.steve02081504.fountp2p.registries.registerRpcInboundHandler
import io.github.steve02081504.fountp2p.wire.DefaultWireContext
import io.github.steve02081504.fountp2p.wire.WireAdapter
import io.github.steve02081504.fountp2p.wire.WireHandler
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 记录注册与发送的内存 wire。 */
internal class PartMemoryWire : WireAdapter {
	val handlers = LinkedHashMap<String, MutableSet<WireHandler>>()
	val sent = ArrayList<Triple<String, Any?, String?>>()

	override fun on(name: String, handler: WireHandler): () -> Unit {
		val set = handlers.getOrPut(name) { linkedSetOf() }
		set.add(handler)
		return { set.remove(handler) }
	}

	override fun send(name: String, payload: Any?, peerId: String?) {
		sent.add(Triple(name, payload, peerId))
	}

	/** @return 按 action 名触发所有 handler。 */
	fun dispatch(name: String, payload: Any?, peerId: String = "") {
		for (handler in handlers[name]?.toList() ?: emptyList()) handler(payload, peerId)
	}
}

/** `wire/part/ingress.mjs` 的等价测试。 */
class PartWireTest {
	private val wire = PartMemoryWire()

	@After
	fun resetInbound() {
		registerRpcInboundHandler("part_invoke") { _, _ -> null }
		registerDeliveryInboundHandler("part_timeline_put") { _, _ -> }
		pendingPartInvoke.clear()
	}

	@Test
	fun `part_timeline_put dispatches delivery inbound with normalized message`() = runBlocking {
		attachPartWire(DefaultWireContext("alice"), wire)
		var received: Map<String, Any?>? = null
		var context: InboundContext? = null
		registerDeliveryInboundHandler("part_timeline_put") { inboundContext, message ->
			context = inboundContext
			received = message
		}

		wire.dispatch(
			"part_timeline_put",
			mapOf(
				"partpath" to "shells/social",
				"timelineEntityHash" to "hash-1",
				"event" to mapOf("id" to "e1"),
				"nodeHash" to "n1",
				"groupId" to "g1",
			),
			"peer-a",
		)

		awaitCondition { received != null }
		val message = received!!
		assertEquals("part_timeline_put", message["type"])
		assertEquals("shells/social", message["partpath"])
		assertEquals("hash-1", message["timelineEntityHash"])
		assertEquals(mapOf("id" to "e1"), message["event"])
		assertEquals("n1", message["nodeHash"])
		assertEquals("g1", message["groupId"])
		assertEquals("alice", context?.replicaUsername)
		assertEquals("peer-a", context?.requesterNodeHash)
	}

	@Test
	fun `part_timeline_put ignores malformed payloads`() = runBlocking {
		attachPartWire(DefaultWireContext("alice"), wire)
		var calls = 0
		registerDeliveryInboundHandler("part_timeline_put") { _, _ -> calls++ }

		wire.dispatch("part_timeline_put", mapOf("partpath" to "bad path", "timelineEntityHash" to "h", "event" to mapOf<String, Any?>()), "peer-a")
		wire.dispatch("part_timeline_put", mapOf("partpath" to "shells/social", "timelineEntityHash" to "", "event" to mapOf<String, Any?>()), "peer-a")
		wire.dispatch("part_timeline_put", "not-an-object", "peer-a")
		wire.dispatch("part_timeline_put", mapOf("partpath" to "shells/social", "timelineEntityHash" to "h", "event" to "x"), "peer-a")

		Thread.sleep(50)
		assertEquals(0, calls)
	}

	@Test
	fun `part_invoke with requestId replies with part_invoke_response`() = runBlocking {
		attachPartWire(DefaultWireContext("alice"), wire)
		registerRpcInboundHandler("part_invoke") { _, message ->
			assertEquals("shells/social", message["partpath"])
			assertEquals("r1", message["requestId"])
			mapOf("result" to mapOf("ok" to true))
		}

		wire.dispatch(
			"part_invoke",
			mapOf("partpath" to "shells/social", "invoke" to mapOf("kind" to "ping"), "requestId" to "r1"),
			"peer-a",
		)

		awaitCondition { wire.sent.isNotEmpty() }
		val (name, payload, peerId) = wire.sent[0]
		assertEquals("part_invoke_response", name)
		assertEquals("peer-a", peerId)
		@Suppress("UNCHECKED_CAST")
		val body = payload as Map<String, Any?>
		assertEquals("r1", body["requestId"])
		assertEquals("shells/social", body["partpath"])
		assertEquals(mapOf("result" to mapOf("ok" to true)), body["response"])
	}

	@Test
	fun `part_invoke without requestId forwards follow-up invoke`() = runBlocking {
		attachPartWire(DefaultWireContext("alice"), wire)
		val followUp = mapOf("kind" to "pong", "data" to "x")
		registerRpcInboundHandler("part_invoke") { _, _ -> mapOf("result" to followUp) }

		wire.dispatch(
			"part_invoke",
			mapOf("partpath" to "shells/social", "invoke" to mapOf("kind" to "ping"), "groupId" to "g1"),
			"peer-a",
		)

		awaitCondition { wire.sent.isNotEmpty() }
		val (name, payload, peerId) = wire.sent[0]
		assertEquals("part_invoke", name)
		assertEquals("peer-a", peerId)
		assertEquals(
			mapOf("partpath" to "shells/social", "invoke" to followUp, "nodeHash" to "peer-a", "groupId" to "g1"),
			payload,
		)
	}

	@Test
	fun `part_invoke without requestId and non invoke result sends nothing`() = runBlocking {
		attachPartWire(DefaultWireContext("alice"), wire)
		registerRpcInboundHandler("part_invoke") { _, _ -> mapOf("result" to "plain") }

		wire.dispatch("part_invoke", mapOf("partpath" to "shells/social", "invoke" to mapOf("kind" to "ping")), "peer-a")
		Thread.sleep(50)
		assertTrue(wire.sent.isEmpty())
	}

	@Test
	fun `allowPartInvoke false blocks dispatch`() = runBlocking {
		attachPartWire(
			DefaultWireContext("alice"),
			wire,
			PartWireOptions(allowPartInvoke = { false }),
		)
		var calls = 0
		registerRpcInboundHandler("part_invoke") { _, _ ->
			calls++
			mapOf("result" to mapOf("ok" to true))
		}

		wire.dispatch("part_invoke", mapOf("partpath" to "shells/social", "invoke" to mapOf("kind" to "ping"), "requestId" to "r1"), "peer-a")
		Thread.sleep(50)
		assertEquals(0, calls)
		assertTrue(wire.sent.isEmpty())
	}

	@Test
	fun `part_invoke_response routes into pending collector`() = runBlocking {
		attachPartWire(DefaultWireContext("alice"), wire)
		val responses = mutableListOf<Any?>()
		pendingPartInvoke["r1"] = PendingPartInvoke(responses, {}, 1, mutableSetOf())

		wire.dispatch(
			"part_invoke_response",
			mapOf("requestId" to "r1", "response" to mapOf("result" to mapOf("from" to "peer-a"))),
			"peer-a",
		)

		assertEquals(listOf(mapOf("result" to mapOf("from" to "peer-a"))), responses)
	}

	@Test
	fun `attachPartWire dispose stops handlers`() = runBlocking {
		val dispose = attachPartWire(DefaultWireContext("alice"), wire)
		dispose()
		wire.dispatch("part_timeline_put", mapOf("partpath" to "shells/social"), "peer-a")
		assertEquals(0, wire.handlers["part_timeline_put"]?.size ?: 0)
	}

	@Test
	fun `attachGroupPartWire filters by groupId`() = runBlocking {
		attachGroupPartWire(DefaultWireContext("alice"), "g1", wire)
		val seen = ArrayList<String>()
		registerRpcInboundHandler("part_invoke") { _, message ->
			seen.add(message["partpath"] as String)
			mapOf("result" to mapOf("ok" to true))
		}

		wire.dispatch("part_invoke", mapOf("groupId" to "g1", "partpath" to "shells/social", "invoke" to mapOf("kind" to "a"), "requestId" to "r1"), "peer-a")
		wire.dispatch("part_invoke", mapOf("groupId" to "g2", "partpath" to "shells/cabinet", "invoke" to mapOf("kind" to "b"), "requestId" to "r2"), "peer-a")
		awaitCondition { seen.isNotEmpty() }
		assertEquals(listOf("shells/social"), seen)
	}

	@Test
	fun `dispatchRpcInbound returns null for unregistered types`() = runBlocking {
		registerRpcInboundHandler("part_invoke") { _, _ -> null }
		assertNull(dispatchRpcInbound(InboundContext(), linkedMapOf("type" to "part_invoke")))
		assertNull(dispatchRpcInbound(InboundContext(), linkedMapOf<String, Any?>("type" to "nope")))
		dispatchDeliveryInbound(InboundContext(), linkedMapOf<String, Any?>("type" to "nope"))
	}
}
