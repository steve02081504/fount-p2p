package io.github.steve02081504.fountp2p.transport.node_scope

import io.github.steve02081504.fountp2p.transport.LinkRegistry
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * 将 [NodeScopeLinkBridge] 接到 [LinkRegistry]（等价 JS 中 node_scope/wire.mjs 直接
 * import `link_registry.mjs` 的 `subscribeScope` / `sendToNodeLink`）。
 *
 * 偏离：JS `sendToNodeLink` 返回 promise 但调用方不 await；Kotlin 用私有 scope 发起。
 */
class LinkRegistryNodeScopeBridge(private val registry: LinkRegistry) : NodeScopeLinkBridge {
	private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

	override fun subscribeScope(
		scope: String,
		listener: (senderNodeHash: String, envelope: NodeScopeEnvelope) -> Unit,
	): () -> Unit = registry.subscribeScope(scope) { senderNodeHash, envelope ->
		listener(
			senderNodeHash,
			NodeScopeEnvelope(
				scope = envelope["scope"]?.toString() ?: "node",
				action = envelope["action"]?.toString() ?: "",
				payload = envelope["payload"],
			),
		)
	}

	override fun sendToNodeLink(remoteNodeHash: String, envelope: NodeScopeEnvelope) {
		scope.launch {
			try {
				registry.sendToNodeLink(
					remoteNodeHash,
					linkedMapOf(
						"scope" to envelope.scope,
						"action" to envelope.action,
						"payload" to envelope.payload,
					),
				)
			}
			catch (_: Exception) {
				// ignore
			}
		}
	}
}
