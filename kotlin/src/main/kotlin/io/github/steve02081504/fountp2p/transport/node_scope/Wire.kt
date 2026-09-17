package io.github.steve02081504.fountp2p.transport.node_scope

import io.github.steve02081504.fountp2p.wire.WireAdapter
import io.github.steve02081504.fountp2p.wire.WireContext
import io.github.steve02081504.fountp2p.wire.WireHandler

/**
 * node scope 派发与 wire（等价 `js/transport/node_scope/wire.mjs`）。
 *
 * 偏离：JS 直接 import `link_registry.mjs` 的 `subscribeScope` / `sendToNodeLink`；
 * Kotlin 侧 link/ 尚未移植，改为可注入的 [NodeScopeLinkBridge]（默认 no-op），
 * link registry 落地后由集成方 `configureNodeScopeLinkBridge` 注入真实实现。
 */

/** node scope 入站 envelope（`{ scope, action, payload }`）。 */
data class NodeScopeEnvelope(val scope: String, val action: String, val payload: Any?)

/**
 * link_registry 依赖注入桥。
 */
interface NodeScopeLinkBridge {
	/**
	 * @param scope scope 前缀
	 * @param listener 入站回调（发送方 nodeHash + envelope）
	 * @return 取消订阅
	 */
	fun subscribeScope(scope: String, listener: (senderNodeHash: String, envelope: NodeScopeEnvelope) -> Unit): () -> Unit

	/**
	 * @param remoteNodeHash 远端节点 64 hex
	 * @param envelope 信封
	 */
	fun sendToNodeLink(remoteNodeHash: String, envelope: NodeScopeEnvelope)
}

/** 默认空实现（link registry 未接入时静默）。 */
object NoopNodeScopeLinkBridge : NodeScopeLinkBridge {
	override fun subscribeScope(scope: String, listener: (String, NodeScopeEnvelope) -> Unit): () -> Unit = { }
	override fun sendToNodeLink(remoteNodeHash: String, envelope: NodeScopeEnvelope) = Unit
}

private var nodeScopeLinkBridge: NodeScopeLinkBridge = NoopNodeScopeLinkBridge

/**
 * 注入 link registry 桥（`subscribeScope` / `sendToNodeLink`）。
 * @param bridge 实现
 */
fun configureNodeScopeLinkBridge(bridge: NodeScopeLinkBridge) {
	nodeScopeLinkBridge = bridge
}

/** node action → 入站 handler 集合。 */
private val nodeActionHandlers = LinkedHashMap<String, MutableSet<WireHandler>>()

/** node scope wire 就绪 hook。 */
private val nodeScopeWireHooks = LinkedHashSet<(WireContext, WireAdapter) -> Unit>()

/** mutable node scope 上下文（等价 JS `{ replicaUsername: '' }`）。 */
class MutableNodeScopeContext(override var replicaUsername: String? = "") : WireContext

private val nodeScopeContext = MutableNodeScopeContext()

private var nodeScopeWire: WireAdapter? = null

private var nodeScopeSubscribeCleanup: (() -> Unit)? = null

/** @return node scope 的 wire 适配器 */
private fun createNodeScopeWire(): WireAdapter = object : WireAdapter {
	override fun on(name: String, handler: WireHandler): (() -> Unit)? {
		val set = nodeActionHandlers.getOrPut(name) { LinkedHashSet() }
		set.add(handler)
		return {
			val current = nodeActionHandlers[name]
			if (current != null) {
				current.remove(handler)
				if (current.isEmpty()) nodeActionHandlers.remove(name)
			}
		}
	}

	override fun send(name: String, payload: Any?, peerId: String?) {
		if (peerId.isNullOrEmpty()) return
		nodeScopeLinkBridge.sendToNodeLink(peerId, NodeScopeEnvelope("node", name, payload))
	}
}

/**
 * @param action action 名
 * @return 是否已挂载处理器
 */
fun hasNodeScopeAction(action: String): Boolean = (nodeActionHandlers[action]?.size ?: 0) > 0

/**
 * @param action action 名
 * @return 已注册的处理器数量
 */
fun countNodeScopeActionHandlers(action: String): Int = nodeActionHandlers[action]?.size ?: 0

/**
 * 测试/调试：直接派发已挂载的 node action。
 * @param action action 名
 * @param payload 载荷
 * @param peerId 发送方 nodeHash
 * @return 是否有处理器被调用
 */
fun dispatchNodeScopeAction(action: String, payload: Any?, peerId: String): Boolean {
	val handlers = nodeActionHandlers[action]
	if (handlers.isNullOrEmpty()) return false
	for (handler in handlers.toList()) {
		try {
			handler(payload, peerId)
		}
		catch (_: Throwable) {
			// ignore
		}
	}
	return true
}

/** @return 当前 wire，未 ensure 时为 null */
fun getNodeScopeWire(): WireAdapter? = nodeScopeWire

/** @return 可变 node scope 上下文 */
fun getNodeScopeContext(): WireContext = nodeScopeContext

/**
 * 只订阅 node scope 派发，不挂任何 feature。
 * @param options 可选副本用户名
 * @return 取消订阅的 dispose
 */
fun ensureNodeScope(options: Map<String, Any?> = emptyMap()): () -> Unit {
	val replicaUsername = options["replicaUsername"]
	if (replicaUsername != null) nodeScopeContext.replicaUsername = replicaUsername.toString()
	nodeScopeSubscribeCleanup?.let { return it }
	val cleanup = nodeScopeLinkBridge.subscribeScope("node") { senderNodeHash, envelope ->
		val handlers = nodeActionHandlers[envelope.action]
		if (handlers.isNullOrEmpty()) return@subscribeScope
		for (handler in handlers.toList()) {
			try {
				handler(envelope.payload, senderNodeHash)
			}
			catch (_: Throwable) {
				// ignore
			}
		}
	}
	nodeScopeSubscribeCleanup = cleanup
	if (nodeScopeWire == null) {
		val wire = createNodeScopeWire()
		nodeScopeWire = wire
		for (hook in nodeScopeWireHooks.toList()) {
			try {
				hook(nodeScopeContext, wire)
			}
			catch (_: Throwable) {
				// ignore
			}
		}
	}
	return cleanup
}

/**
 * 在 node scope wire 创建时（或已存在时立即）回调；shell 用此挂自定义 action。
 * @param hook wire 就绪回调
 * @return 取消注册的 dispose
 */
fun registerNodeScopeWireHook(hook: (context: WireContext, wire: WireAdapter) -> Unit): () -> Unit {
	nodeScopeWireHooks.add(hook)
	val current = nodeScopeWire
	if (current != null) {
		try {
			hook(nodeScopeContext, current)
		}
		catch (_: Throwable) {
			// ignore
		}
	}
	return { nodeScopeWireHooks.remove(hook) }
}

/**
 * 卸掉 scope 订阅与 wire（feature 须先卸）。
 */
fun clearNodeScopeSubscribe() {
	nodeScopeSubscribeCleanup?.invoke()
	nodeScopeSubscribeCleanup = null
	nodeScopeWire = null
	nodeActionHandlers.clear()
}
