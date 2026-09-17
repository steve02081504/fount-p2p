package io.github.steve02081504.fountp2p.infra

import io.github.steve02081504.fountp2p.node.NodeLogger
import io.github.steve02081504.fountp2p.transport.getLinkRegistry

private val cleanups = mutableListOf<() -> Unit>()

/**
 * 挂载 registry link/overlay/node scope 调试日志。
 * @param logger 日志输出目标，null 表示静默
 * @return 取消 debug 监听的 dispose
 */
fun attachInfraDebugLog(logger: NodeLogger?): () -> Unit {
	detachInfraDebugLog()
	if (logger == null) return {}
	val registry = getLinkRegistry()

	fun log(level: String, message: String, extra: Map<String, Any?>) {
		when (level) {
			"warn" -> logger.warn(message, extra)
			"error" -> logger.error(message, extra)
			else -> logger.info(message, extra)
		}
	}

	cleanups.add(registry.onLinkUp { nodeHash, link ->
		log("info", "p2p:infra link up", mapOf("nodeHash" to nodeHash, "providerId" to link?.providerId, "level" to link?.level))
	})
	cleanups.add(registry.onLinkDown { nodeHash, reason ->
		log("info", "p2p:infra link down", mapOf("nodeHash" to nodeHash, "reason" to reason))
	})
	cleanups.add(registry.subscribeScope("overlay") { from, envelope ->
		val payload = envelope["payload"] as? Map<*, *>
		log("info", "p2p:infra overlay", mapOf("from" to from, "action" to envelope["action"], "path" to payload?.get("path")))
	})
	cleanups.add(registry.subscribeScope("node") { from, envelope ->
		log("info", "p2p:infra node", mapOf("from" to from, "action" to envelope["action"]))
	})
	return ::detachInfraDebugLog
}

/**
 * 卸掉 infra debug 监听。
 */
fun detachInfraDebugLog() {
	for (cleanup in cleanups.toList())
		try {
			cleanup()
		}
		catch (_: Throwable) {
			// ignore
		}
	cleanups.clear()
}
