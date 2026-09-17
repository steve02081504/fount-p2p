package io.github.steve02081504.fountp2p.overlay

import io.github.steve02081504.fountp2p.TestIdentity
import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.crypto.sign
import io.github.steve02081504.fountp2p.identity
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.supervisorScope
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 等价 `js/test/pure/overlay_router.test.mjs`。
 */
class OverlayRouterTest {
	/** 内存 overlay 网络（邻接表 + 各节点 scope 监听）。 */
	private class FakeNetwork(private val edges: Map<String, List<String>>) {
		val registries = LinkedHashMap<String, FakeRegistry>()

		fun neighborsOf(nodeHash: String): List<String> = edges[nodeHash] ?: emptyList()

		fun makeRegistry(identity: TestIdentity): FakeRegistry {
			val registry = FakeRegistry(identity, this)
			registries[identity.nodeHash] = registry
			return registry
		}
	}

	private class FakeRegistry(
		val identity: TestIdentity,
		private val network: FakeNetwork,
	) : OverlayRegistry {
		override val localIdentity: Map<String, Any?> = linkedMapOf(
			"nodeHash" to identity.nodeHash,
			"nodePubKey" to identity.nodePubKey,
			"secretKey" to identity.secretKey,
		)

		val scopeListeners = LinkedHashMap<String, MutableSet<(String, Map<String, Any?>) -> Unit>>()

		/** 发送拦截（仅观察，不影响投递）。 */
		var onSend: ((String, Map<String, Any?>) -> Unit)? = null

		override fun listLinks(): List<OverlayLinkRef> =
			network.neighborsOf(identity.nodeHash).map { OverlayLinkRef(it) }

		override fun subscribeScope(
			prefix: String,
			handler: (String, Map<String, Any?>) -> Unit,
		): () -> Unit {
			val set = scopeListeners.getOrPut(prefix) { LinkedHashSet() }
			set.add(handler)
			return { set.remove(handler); Unit }
		}

		override suspend fun sendToNodeLink(nodeHash: String, envelope: Map<String, Any?>): Boolean {
			onSend?.invoke(nodeHash, envelope)
			val target = network.registries[nodeHash] ?: return false
			for ((prefix, handlers) in target.scopeListeners) {
				if ((envelope["scope"]?.toString() ?: "").startsWith(prefix))
					for (handler in handlers.toList()) handler(identity.nodeHash, envelope)
			}
			return true
		}
	}

	@Test
	fun `overlay router drops relay without a valid origin signature`() = runBlocking {
		val ids = listOf(31, 32, 33).map { identity(it) }
		val edges = mapOf(
			ids[2].nodeHash to listOf(ids[1].nodeHash),
			ids[1].nodeHash to listOf(ids[2].nodeHash),
		)
		val network = FakeNetwork(edges)
		val attackerRegistry = network.makeRegistry(ids[2])
		val targetRegistry = network.makeRegistry(ids[1])
		val attacker = createOverlayRouter(attackerRegistry)
		val target = createOverlayRouter(targetRegistry)
		val received = ArrayList<Pair<Any?, RelayMeta>>()
		val stop = target.onRelay { body, meta -> received.add(body to meta) }
		try {
			// 冒充第三方 origin，无签名：必须被丢弃。
			attackerRegistry.sendToNodeLink(
				ids[1].nodeHash,
				mapOf(
					"scope" to "overlay",
					"action" to "relay",
					"payload" to mapOf(
						"action" to "relay",
						"path" to listOf(ids[0].nodeHash, ids[1].nodeHash),
						"idx" to 1.0,
						"body" to mapOf("forged" to true),
					),
				),
			)
			delay(50)
			assertEquals(0, received.size)
			// 用自己的身份走合法 relay API：应送达并以自己为来源。
			attacker.relay(listOf(ids[2].nodeHash, ids[1].nodeHash), mapOf("legit" to true))
			delay(50)
			assertEquals(1, received.size)
			assertEquals(ids[2].nodeHash, received[0].second.path[0])
		}
		finally {
			stop()
			attacker.close()
			target.close()
		}
	}

	@Test
	fun `overlay router rate-limits route_req by default without infra`() = runBlocking {
		val ids = listOf(21, 22, 23).map { identity(it) }
		val edges = mapOf(
			ids[0].nodeHash to listOf(ids[1].nodeHash, ids[2].nodeHash),
			ids[1].nodeHash to listOf(ids[0].nodeHash),
			ids[2].nodeHash to listOf(ids[0].nodeHash),
		)
		val network = FakeNetwork(edges)
		val localRegistry = network.makeRegistry(ids[0])
		network.makeRegistry(ids[1])
		val attackerRegistry = network.makeRegistry(ids[2])
		val local = createOverlayRouter(localRegistry)
		var forwarded = 0
		localRegistry.onSend = { _, _ -> forwarded++ }
		try {
			val target = "f".repeat(64)
			for (i in 0 until 40) {
				attackerRegistry.sendToNodeLink(
					ids[0].nodeHash,
					mapOf(
						"scope" to "overlay",
						"action" to "route_req",
						"payload" to mapOf(
							"action" to "route_req",
							"reqId" to "flood-$i",
							"target" to target,
							"ttl" to 3.0,
							"path" to listOf(ids[2].nodeHash),
						),
					),
				)
				delay(3)
			}
			delay(100)
			// 默认桶 burst=30：第 31 条起被丢弃，不再向其它链路转发。
			assertTrue("expected >=30 forwarded, got $forwarded", forwarded >= 30)
			assertTrue("expected <40 forwarded, got $forwarded", forwarded < 40)
		}
		finally {
			local.close()
		}
	}

	@Test
	fun `overlay router relays payload across a chain`() = runBlocking {
		val ids = listOf(1, 2, 3, 4, 5).map { identity(it) }
		val edges = mapOf(
			ids[0].nodeHash to listOf(ids[1].nodeHash),
			ids[1].nodeHash to listOf(ids[0].nodeHash, ids[2].nodeHash),
			ids[2].nodeHash to listOf(ids[1].nodeHash, ids[3].nodeHash),
			ids[3].nodeHash to listOf(ids[2].nodeHash, ids[4].nodeHash),
			ids[4].nodeHash to listOf(ids[3].nodeHash),
		)
		val network = FakeNetwork(edges)
		val routers = ids.map { createOverlayRouter(network.makeRegistry(it)) }
		val received = ArrayList<Any?>()
		val stop = routers[4].onRelay { body, _ -> received.add(body) }
		try {
			val path = ids.map { it.nodeHash }
			routers[0].relay(path, mapOf("ok" to true))
			delay(100)
			assertEquals(1, received.size)
			assertEquals(true, (received[0] as Map<*, *>)["ok"])
		}
		finally {
			stop()
			for (router in routers) router.close()
		}
	}

	@Test
	fun `overlay router ignores route response whose path does not end at the target`() = runBlocking {
		val ids = listOf(11, 12, 13).map { identity(it) }
		val edges = mapOf(
			ids[0].nodeHash to listOf(ids[1].nodeHash),
			ids[1].nodeHash to listOf(ids[0].nodeHash),
		)
		val network = FakeNetwork(edges)
		val leftRegistry = network.makeRegistry(ids[0])
		val evilRegistry = network.makeRegistry(ids[1])
		val left = createOverlayRouter(leftRegistry)
		var capturedReqId = ""
		leftRegistry.onSend = { _, envelope ->
			if (envelope["action"] == "route_req")
				capturedReqId = (envelope["payload"] as? Map<*, *>)?.get("reqId")?.toString() ?: ""
		}
		try {
			supervisorScope {
				val routeJob = async { left.discoverRoute(ids[2].nodeHash, mapOf("timeoutMs" to 80.0)) }
				delay(30)
				assertTrue(capturedReqId.isNotEmpty())
				val fakePath = listOf(ids[0].nodeHash, ids[1].nodeHash)
				val sig = sign(
					"fount-route\u0000$capturedReqId\u0000${fakePath.joinToString(",")}",
					ids[1].secretKey,
				)
				evilRegistry.sendToNodeLink(
					ids[0].nodeHash,
					mapOf(
						"scope" to "overlay",
						"action" to "route_resp",
						"payload" to mapOf(
							"action" to "route_resp",
							"reqId" to capturedReqId,
							"path" to fakePath,
							"nodePubKey" to ids[1].nodePubKey,
							"sig" to bytesToHex(sig),
						),
					),
				)
				// 伪造路径终点不是目标：必须被忽略，最终超时拒绝。
				var threw = false
				try {
					routeJob.await()
				}
				catch (_: Exception) {
					threw = true
				}
				assertTrue(threw)
			}
		}
		finally {
			left.close()
		}
	}

	@Test
	fun `overlay router rejects forged route responses`() = runBlocking {
		val ids = listOf(7, 8).map { identity(it) }
		val edges = mapOf(
			ids[0].nodeHash to listOf(ids[1].nodeHash),
			ids[1].nodeHash to listOf(ids[0].nodeHash),
		)
		val network = FakeNetwork(edges)
		val left = createOverlayRouter(network.makeRegistry(ids[0]))
		val rightRegistry = network.makeRegistry(ids[1])
		try {
			supervisorScope {
				val routeJob = async { left.discoverRoute(ids[1].nodeHash, mapOf("timeoutMs" to 50.0)) }
				delay(10)
				rightRegistry.sendToNodeLink(
					ids[0].nodeHash,
					mapOf(
						"scope" to "overlay",
						"action" to "route_resp",
						"payload" to mapOf(
							"action" to "route_resp",
							"reqId" to "bad",
							"path" to listOf(ids[0].nodeHash, ids[1].nodeHash),
							"nodePubKey" to ids[1].nodePubKey,
							"sig" to "00".repeat(64),
						),
					),
				)
				var threw = false
				try {
					routeJob.await()
				}
				catch (_: Exception) {
					threw = true
				}
				assertTrue(threw)
			}
		}
		finally {
			left.close()
		}
	}
}
