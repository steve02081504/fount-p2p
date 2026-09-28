package io.github.steve02081504.fountp2p

import io.github.steve02081504.fountp2p.core.JsonUndefined
import io.github.steve02081504.fountp2p.node.EntityStore
import io.github.steve02081504.fountp2p.node.NodeInitOptions
import io.github.steve02081504.fountp2p.node.NodeLogger
import io.github.steve02081504.fountp2p.node.ensureNodeDefaults
import io.github.steve02081504.fountp2p.node.initNode
import io.github.steve02081504.fountp2p.node.isNodeInitialized
import io.github.steve02081504.fountp2p.node.setNodeLogger
import io.github.steve02081504.fountp2p.node.setP2PFeatures
import io.github.steve02081504.fountp2p.node.setSignalingRuntimeConfig
import io.github.steve02081504.fountp2p.transport.getLinkRegistry

/**
 * `startNode` 选项（等价 JS `startNode(options)`）。
 *
 * 未提供的可选字段用 [JsonUndefined] 表示（等价 JS `undefined`）。
 */
class StartNodeOptions(
	val nodeDir: String? = null,
	val entityStore: EntityStore? = null,
	val logger: Any? = JsonUndefined,
	val signaling: Map<String, Any?>? = null,
	val features: Map<String, Any?>? = null,
)

/**
 * 初始化（首次）并启动节点链路运行时。
 *
 * 等价 JS `startNode`：首次调用传 [StartNodeOptions]；已初始化后再传选项会抛错
 * （应改用 [setNodeLogger] / [setSignalingRuntimeConfig] / [setP2PFeatures]）。
 *
 * @param options 首次 init 时的节点选项
 */
suspend fun startNode(options: StartNodeOptions = StartNodeOptions()) {
	if (!isNodeInitialized()) {
		initNode(NodeInitOptions(nodeDir = options.nodeDir, entityStore = options.entityStore))
		if (options.logger !== JsonUndefined) setNodeLogger(options.logger as? NodeLogger)
		options.signaling?.let { setSignalingRuntimeConfig(it) }
		options.features?.let { setP2PFeatures(it) }
	}
	else if (options.nodeDir != null || options.entityStore != null || options.logger !== JsonUndefined ||
		options.signaling != null || options.features != null
	)
		throw IllegalStateException(
			"p2p: startNode options ignored after initNode — use setNodeLogger / setSignalingRuntimeConfig / setP2PFeatures",
		)

	ensureNodeDefaults()
	getLinkRegistry().ensureRuntime()
}

/**
 * 包门面：聚合常用入口便于 Android 端使用。
 *
 * JS `index.mjs` 的具名导出在 Kotlin 中直接按包导入（如
 * `io.github.steve02081504.fountp2p.transport.getLinkRegistry`）。
 */
object FountP2p {
	// 节点
	suspend fun closeNode() = io.github.steve02081504.fountp2p.node.closeNode()
	fun isNodeInitialized(): Boolean = io.github.steve02081504.fountp2p.node.isNodeInitialized()
	fun getNodeDir(): String = io.github.steve02081504.fountp2p.node.getNodeDir()
	fun configureNodeStorage(nodeDir: String?): String =
		io.github.steve02081504.fountp2p.node.configureNodeStorage(nodeDir)
	fun getNodeHash(): String = io.github.steve02081504.fountp2p.node.getNodeHash()
	fun ensureNodeDefaults(): Map<String, Any?> = io.github.steve02081504.fountp2p.node.ensureNodeDefaults()
	fun getP2PFeatures(): Map<String, Any?> = io.github.steve02081504.fountp2p.node.getP2PFeatures()
	fun setP2PFeatures(config: Map<String, Any?>?) = io.github.steve02081504.fountp2p.node.setP2PFeatures(config)
	fun setNodeLogger(logger: NodeLogger?) = io.github.steve02081504.fountp2p.node.setNodeLogger(logger)
	fun setSignalingRuntimeConfig(config: Map<String, Any?>?) =
		io.github.steve02081504.fountp2p.node.setSignalingRuntimeConfig(config)

	fun setConnectivityDebug(enabled: Boolean) = io.github.steve02081504.fountp2p.node.setConnectivityDebug(enabled)

	// discovery / link providers
	fun registerDiscoveryProvider(provider: io.github.steve02081504.fountp2p.discovery.DiscoveryProvider): () -> Unit =
		io.github.steve02081504.fountp2p.discovery.registerDiscoveryProvider(provider)

	fun registerLinkProvider(provider: io.github.steve02081504.fountp2p.link.providers.LinkProvider): () -> Unit =
		io.github.steve02081504.fountp2p.link.providers.registerLinkProvider(provider)

	fun getNodePopulationEstimate(): Map<String, Any?> =
		io.github.steve02081504.fountp2p.discovery.nostr.getNodePopulationEstimate()

	// infra
	fun isInfraRunning(): Boolean = io.github.steve02081504.fountp2p.infra.isInfraRunning()
	suspend fun startInfra(options: io.github.steve02081504.fountp2p.infra.InfraOptions =
			io.github.steve02081504.fountp2p.infra.InfraOptions()) =
		io.github.steve02081504.fountp2p.infra.startInfra(options)

	suspend fun stopInfra() = io.github.steve02081504.fountp2p.infra.stopInfra()

	// transport / mesh
	suspend fun ensureLinkToNode(nodeHash: String) = io.github.steve02081504.fountp2p.transport.ensureLinkToNode(nodeHash)

	suspend fun sendToNodeLink(nodeHash: String, envelope: Map<String, Any?>): Boolean =
		io.github.steve02081504.fountp2p.transport.sendToNodeLink(nodeHash, envelope)

	fun getPeerHealth(nodeHash: String) = io.github.steve02081504.fountp2p.transport.getPeerHealth(nodeHash)

	fun listPeerHealth() = io.github.steve02081504.fountp2p.transport.listPeerHealth()

	fun onPeerHealth(listener: (String, io.github.steve02081504.fountp2p.transport.PeerHealthEntry) -> Unit): () -> Unit =
		io.github.steve02081504.fountp2p.transport.onPeerHealth(listener)

	suspend fun ensureChannelAvailable(channel: String): Boolean =
		io.github.steve02081504.fountp2p.transport.ensureChannelAvailable(channel)

	suspend fun reloadDiscoveryRelays() = io.github.steve02081504.fountp2p.transport.reloadDiscoveryRelays()

	// 信誉同步
	fun attachReputationSyncWire(): () -> Unit = io.github.steve02081504.fountp2p.node.attachReputationSyncWire()
}
