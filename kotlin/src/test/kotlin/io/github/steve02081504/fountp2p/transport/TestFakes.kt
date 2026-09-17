package io.github.steve02081504.fountp2p.transport

import io.github.steve02081504.fountp2p.link.providers.LinkHandle
import io.github.steve02081504.fountp2p.link.providers.LinkProvider
import kotlinx.coroutines.CompletableDeferred

/** 无操作的运行时暖机（测试用），使 link registry 不触碰真实网络。 */
class FakeRuntimeBootstrap : RuntimeBootstrap {
	override fun isLive(): Boolean = true
	override fun lanTcpPort(): Int? = null
	override fun ownedLanTcp(): LinkProvider? = null
	override fun ownedBleGatt(): LinkProvider? = null
	override suspend fun ensureRuntime() { }
	override suspend fun ensureChannelAvailable(channel: String): Boolean = true
	override suspend fun whenListening() { }
	override suspend fun whenSignalListening() { }
	override suspend fun buildLocalAdvert(scope: Any?): Map<String, Any?> = emptyMap()
	override suspend fun reloadDiscoveryRelays() { }
	override suspend fun shutdown() { }
}

/** 记录关闭原因的 mock link（等价 JS `mockLink`）。 */
class MockLinkHandle(
	override val nodeHash: String?,
	override val initiator: Boolean,
	override val level: Double,
	override val providerId: String,
) : LinkHandle {
	override val ready: CompletableDeferred<Unit> = CompletableDeferred(Unit)
	private val downListeners = LinkedHashSet<(String) -> Unit>()
	var closedReason: String? = null

	override suspend fun send(envelope: Map<String, Any?>): Boolean = true

	override fun onEnvelope(callback: (Map<String, Any?>, String) -> Unit): () -> Unit = { }

	override fun onDown(callback: (String) -> Unit): () -> Unit {
		downListeners.add(callback)
		return { downListeners.remove(callback); Unit }
	}

	override fun stats(): Map<String, Any?> = mapOf("providerId" to providerId)

	override suspend fun close(reason: String) {
		closedReason = reason
		for (listener in downListeners.toList()) listener(reason)
	}
}

/** 可配置的 mock link provider。 */
class MockLinkProvider(
	override val id: String,
	override val level: Double,
	private val dialImpl: suspend (Map<String, Any?>) -> LinkHandle?,
	private val canReachValue: Boolean = true,
	private val available: Boolean = true,
	override val caps: Map<String, Any?> = mapOf("needsOfferAnswer" to false),
) : LinkProvider {
	override suspend fun isAvailable(): Boolean = available
	override fun canReach(remote: Map<String, Any?>): Boolean = canReachValue
	override suspend fun dial(options: Map<String, Any?>): LinkHandle? = dialImpl(options)
}
