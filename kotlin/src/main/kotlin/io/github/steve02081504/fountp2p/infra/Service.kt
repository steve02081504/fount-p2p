package io.github.steve02081504.fountp2p.infra

import io.github.steve02081504.fountp2p.core.JsonUndefined
import io.github.steve02081504.fountp2p.node.ConsoleNodeLogger
import io.github.steve02081504.fountp2p.node.NodeLogger
import io.github.steve02081504.fountp2p.node.isNodeInitialized
import io.github.steve02081504.fountp2p.overlay.clearOverlayRateGate
import io.github.steve02081504.fountp2p.overlay.setOverlayRateGate
import io.github.steve02081504.fountp2p.transport.getLinkRegistry
import io.github.steve02081504.fountp2p.transport.node_scope.attachNodeScopeMailbox
import io.github.steve02081504.fountp2p.utils.TokenBucket
import io.github.steve02081504.fountp2p.utils.consumeToken

/** `startInfra` 选项；logger 缺省用 [JsonUndefined] 表示「未提供」（等价 JS undefined）。 */
class InfraOptions(
	val maxActive: Int? = null,
	val logger: Any? = JsonUndefined,
)

private val overlayRateBuckets = HashMap<String, TokenBucket>()

/** 安装 overlay 速率门 */
private fun installOverlayRateLimit() {
	val perMin = maxOf(1, InfraTunables.overlayRatePerMin).toLong()
	val burst = maxOf(1, InfraTunables.overlayRateBurst).toLong()
	setOverlayRateGate { sender, action ->
		if (action != "route_req" && action != "relay") true
		else consumeToken(overlayRateBuckets, sender, System.currentTimeMillis(), perMin, burst)
	}
}

/** 移除 overlay 速率门并清空桶 */
private fun removeOverlayRateLimit() {
	clearOverlayRateGate()
	overlayRateBuckets.clear()
}

private var infraRunning = false
private var mailboxDispose: (() -> Unit)? = null
private var debugDispose: (() -> Unit)? = null
private var savedMaxActive: Int? = null

/** @return infra relay 是否在运行 */
fun isInfraRunning(): Boolean = infraRunning

/**
 * 启动 public-good infra：overlay、mailbox、rate limit、priority、debug log。
 * @param options maxActive 与 debug logger
 */
suspend fun startInfra(options: InfraOptions = InfraOptions()) {
	if (!isNodeInitialized()) throw IllegalStateException("p2p: startInfra requires initNode")
	if (infraRunning) {
		if (options.maxActive != null) getLinkRegistry().setMaxActive(options.maxActive)
		if (options.logger !== JsonUndefined) {
			detachInfraDebugLog()
			debugDispose = attachInfraDebugLog(options.logger as? NodeLogger)
		}
		applyPriorityToRegistry()
		return
	}
	val registry = getLinkRegistry()
	registry.ensureRuntime()
	registry.ensureOverlayRouter()
	installOverlayRateLimit()
	savedMaxActive = registry.getMaxActive()
	if (options.maxActive != null) registry.setMaxActive(options.maxActive)
	else registry.setMaxActive(InfraTunables.defaultMaxActive)
	if (mailboxDispose == null) mailboxDispose = attachNodeScopeMailbox()
	val logger = if (options.logger === JsonUndefined) ConsoleNodeLogger else options.logger as? NodeLogger
	debugDispose = attachInfraDebugLog(logger)
	applyPriorityToRegistry()
	infraRunning = true
}

/**
 * 卸掉 infra 自己挂的面（mailbox / rate / debug / priority / maxActive 恢复）。
 * 不碰用户另行 attach 的 wires，不绑信誉同步。
 */
suspend fun stopInfra() {
	if (!infraRunning) return
	debugDispose?.invoke()
	debugDispose = null
	detachInfraDebugLog()
	clearInfraPriorityFromRegistry()
	removeOverlayRateLimit()
	mailboxDispose?.invoke()
	mailboxDispose = null
	val registry = getLinkRegistry()
	savedMaxActive?.let { registry.setMaxActive(it) }
	savedMaxActive = null
	infraRunning = false
}
