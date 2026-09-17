package io.github.steve02081504.fountp2p.transport

import io.github.steve02081504.fountp2p.TestIdentity

/** 内存 group registry broker（把 sendToNodeLink 投递到目标 registry 的 scope 监听）。 */
class FakeGroupBroker {
	val registries = LinkedHashMap<String, FakeGroupRegistry>()

	fun register(registry: FakeGroupRegistry) {
		registries[registry.localIdentity["nodeHash"]?.toString() ?: ""] = registry
	}

	/** 双向直连。 */
	fun connect(a: String, b: String) {
		registries[a]?.links?.add(b)
		registries[b]?.links?.add(a)
	}

	fun deliver(from: String, to: String, envelope: Map<String, Any?>) {
		val target = registries[to] ?: return
		for ((prefix, handlers) in target.scopeListeners) {
			if ((envelope["scope"]?.toString() ?: "").startsWith(prefix))
				for (handler in handlers.toList()) handler(from, envelope)
		}
	}
}

/** 等价 JS 测试中手写的无类型 registry。 */
class FakeGroupRegistry(
	override val localIdentity: Map<String, Any?>,
	private val broker: FakeGroupBroker? = null,
) : GroupRegistry {
	val links = LinkedHashSet<String>()
	val scopeListeners = LinkedHashMap<String, MutableSet<(String, Map<String, Any?>) -> Unit>>()
	val scopeInterests = LinkedHashMap<String, List<String>>()
	val upListeners = LinkedHashSet<(String) -> Unit>()
	val downListeners = LinkedHashSet<(String, String) -> Unit>()
	var ensureRuntimeCalls = 0

	override suspend fun ensureRuntime() {
		ensureRuntimeCalls++
	}

	override fun registerScopeInterest(scope: String, nodeHashes: List<String>) {
		scopeInterests[scope] = nodeHashes
	}

	override fun releaseScopeInterest(scope: String) {
		scopeInterests.remove(scope)
	}

	override fun subscribeScope(
		prefix: String,
		listener: (String, Map<String, Any?>) -> Unit,
	): () -> Unit {
		val set = scopeListeners.getOrPut(prefix) { LinkedHashSet() }
		set.add(listener)
		return { set.remove(listener); Unit }
	}

	override fun onLinkUp(listener: (String) -> Unit): () -> Unit {
		upListeners.add(listener)
		return { upListeners.remove(listener); Unit }
	}

	override fun onLinkDown(listener: (String, String) -> Unit): () -> Unit {
		downListeners.add(listener)
		return { downListeners.remove(listener); Unit }
	}

	override fun getLink(nodeHash: String): Any? = if (links.contains(nodeHash)) "link" else null

	override suspend fun ensureLinkToNode(nodeHash: String): Any? {
		links.add(nodeHash)
		return "link"
	}

	override suspend fun sendToNodeLink(remoteNodeHash: String, envelope: Map<String, Any?>): Boolean {
		broker?.deliver(localIdentity["nodeHash"]?.toString() ?: "", remoteNodeHash, envelope)
		return true
	}

	override suspend fun buildLocalAdvert(options: Map<String, Any?>): Map<String, Any?> = emptyMap()
}

/** @return 由固定身份构造 registry 本地身份 map */
fun fakeLocalIdentity(identity: TestIdentity): Map<String, Any?> = linkedMapOf(
	"nodeHash" to identity.nodeHash,
	"nodePubKey" to identity.nodePubKey,
	"secretKey" to identity.secretKey,
)
