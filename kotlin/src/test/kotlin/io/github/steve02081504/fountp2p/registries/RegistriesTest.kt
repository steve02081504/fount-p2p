package io.github.steve02081504.fountp2p.registries

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * action / inbound / part_path / room_provider 注册表的等价测试
 * （JS 侧无独立单测，此处按模块行为补充）。
 */
class RegistriesTest {
	private class FakeRoom : ActionRoom {
		val created = mutableListOf<String>()
		val sends = mutableListOf<Triple<String, Any?, String?>>()
		val handlers = HashMap<String, (Any?, String?) -> Unit>()

		override fun makeAction(name: String): Pair<ActionSend, ActionGet> {
			created.add(name)
			val send = ActionSend { payload, peerId -> sends.add(Triple(name, payload, peerId)) }
			val get = ActionGet { handler -> handlers[name] = handler }
			return send to get
		}
	}

	@Test
	fun `action registry caches makeAction and dispatches send and on`() {
		val room = FakeRoom()
		val registry = createActionRegistry(room)
		registry.register("alpha")
		registry.send("alpha", "payload")
		registry.send("alpha", "payload", "peer-1")
		assertEquals(listOf("alpha"), room.created)
		assertEquals(
			listOf(Triple("alpha", "payload", null), Triple("alpha", "payload", "peer-1")),
			room.sends,
		)

		var received: Any? = null
		registry.on("alpha") { payload, _ -> received = payload }
		room.handlers["alpha"]?.invoke("inbound", "peer-2")
		assertEquals("inbound", received)
	}

	@Test
	fun `action registry register accepts a name list`() {
		val room = FakeRoom()
		createActionRegistry(room).register(listOf("a", "b"))
		assertEquals(listOf("a", "b"), room.created)
	}

	@Test
	fun `part path register get unregister`() {
		registerShellPartpath("social", "shells/social")
		try {
			assertEquals("shells/social", getShellPartpath("social"))
		}
		finally {
			unregisterShellPartpath("social")
		}
		val error = assertThrows(IllegalStateException::class.java) { getShellPartpath("social") }
		assertEquals("shell partpath not registered: social", error.message)
	}

	@Test
	fun `inbound rpc and delivery dispatch by type`() = runBlocking {
		registerRpcInboundHandler("part_invoke") { _, message -> mapOf<String, Any?>("result" to message["x"]) }
		val result = dispatchRpcInbound(InboundContext(peerId = "p"), mapOf("type" to "part_invoke", "x" to 7.0))
		assertEquals(mapOf<String, Any?>("result" to 7.0), result)
		assertNull(dispatchRpcInbound(InboundContext(), mapOf("type" to "missing")))

		var delivered: Map<String, Any?>? = null
		registerDeliveryInboundHandler("part_timeline_put") { _, message -> delivered = message }
		dispatchDeliveryInbound(InboundContext(), mapOf("type" to "part_timeline_put", "n" to 1.0))
		assertEquals(1.0, delivered!!["n"])
		dispatchDeliveryInbound(InboundContext(), mapOf("type" to "missing"))
	}

	@Test
	fun `federation room providers aggregate and unregister`() = runBlocking {
		val slot = FederationRoomSlot(
			groupId = "g1",
			getRoster = { listOf(RosterPeer("peer-1", "node-1")) },
			getPeerIdByNodeHash = { nodeHash -> if (nodeHash == "node-1") "peer-1" else null },
			sendToPeer = { _, _, _ -> },
		)
		registerFederationRoomProvider("chat") { username -> if (username == "u") listOf(slot) else emptyList() }
		try {
			assertEquals(listOf(slot), listFederationRoomSlots("u"))
			assertTrue(listFederationRoomSlots("other").isEmpty())
		}
		finally {
			unregisterFederationRoomProvider("chat")
		}
		assertTrue(listFederationRoomSlots("u").isEmpty())
	}
}
