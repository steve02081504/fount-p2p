package io.github.steve02081504.fountp2p.node

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.JsonUndefined
import java.nio.file.Paths

/**
 * 节点运行时单例（等价 `node/instance.mjs` 的模块级 `runtime`）。
 *
 * JS 用模块级变量持有唯一 node 实例；Kotlin 侧以本文件顶层私有状态等价实现，
 * 公开函数名与语义保持一致（`initNode` / `closeNode` / `setNodeLogger` /
 * `getNodeDir` / feature flags 等）。命名冲突风险见各函数 KDoc。
 */

/** 节点日志器（等价 JS `NodeLogger` 的 warn/error/info/log）。 */
interface NodeLogger {
	/** @param args 日志参数 */
	fun warn(vararg args: Any?) {}

	/** @param args 日志参数 */
	fun error(vararg args: Any?) {}

	/** @param args 日志参数 */
	fun info(vararg args: Any?) {}

	/** @param args 日志参数 */
	fun log(vararg args: Any?) {}
}

/** `console` 等价实现：info/log → stdout，warn/error → stderr。 */
object ConsoleNodeLogger : NodeLogger {
	override fun warn(vararg args: Any?) {
		System.err.println(args.joinToString(" ") { formatLogArg(it) })
	}

	override fun error(vararg args: Any?) {
		System.err.println(args.joinToString(" ") { formatLogArg(it) })
	}

	override fun info(vararg args: Any?) {
		System.out.println(args.joinToString(" ") { formatLogArg(it) })
	}

	override fun log(vararg args: Any?) {
		System.out.println(args.joinToString(" ") { formatLogArg(it) })
	}
}

/** @param value 日志参数 @return 可读文本 */
private fun formatLogArg(value: Any?): String = when (value) {
	null -> "null"
	JsonUndefined -> "undefined"
	is String -> value
	else -> Json.stringify(value) ?: value.toString()
}

/** 节点运行时（等价 JS `NodeRuntime`）。 */
class NodeRuntime(
	/** 节点数据目录绝对路径 */
	var nodeDir: String,
	/** 当前 entity store */
	var entityStore: EntityStore,
	/** 当前日志器；null 表示静默 */
	var logger: NodeLogger?,
	/** 当前 signaling 配置 */
	var signaling: Map<String, Any?>,
	/** 当前包级 feature map */
	var features: Map<String, Any?>,
)

/**
 * `initNode` 选项。
 *
 * JS 用 `{ nodeDir, entityStore }` 且显式拒绝 logger/signaling 字段；Kotlin 侧仍保留
 * [logger] / [signaling] 字段以便复刻同样的错误信息（传入非 null 即抛错）。
 */
class NodeInitOptions(
	/** 节点数据目录 */
	val nodeDir: String? = null,
	/** 可选 entity store */
	val entityStore: EntityStore? = null,
	/** 不允许在 initNode 传入（应为 null） */
	val logger: NodeLogger? = null,
	/** 不允许在 initNode 传入（应为 null） */
	val signaling: Map<String, Any?>? = null,
)

private var runtime: NodeRuntime? = null

private val changeListeners = LinkedHashSet<(String, Any?) -> Unit>()
private val changeListenersGuard = Any()

/** RTC polyfill 缓存世代：策略变更时同步推进，避免动态 import 清缓存前仍命中旧构造器 */
private var rtcPolyfillCacheEpoch = 0

/** @return 当前 RTC polyfill 缓存世代 */
fun getRtcPolyfillCacheEpoch(): Int = rtcPolyfillCacheEpoch

/**
 * @param options 节点目录与可选 entity store
 * @return 初始化后的运行时
 */
fun initNode(options: NodeInitOptions): NodeRuntime {
	if (runtime != null)
		throw IllegalStateException("p2p: initNode already called — use setNodeLogger / setSignalingRuntimeConfig or closeNode")
	if (options.logger != null || options.signaling != null)
		throw IllegalArgumentException("p2p: initNode only accepts nodeDir/entityStore — use setNodeLogger / setSignalingRuntimeConfig")
	val rawDir = options.nodeDir
	if (rawDir.isNullOrBlank()) throw IllegalArgumentException("p2p: initNode requires nodeDir")
	val nodeDir = Paths.get(rawDir).toAbsolutePath().normalize().toString()
	val entityStore = options.entityStore ?: createFsEntityStore(Paths.get(nodeDir, "entities").toString())
	val created = NodeRuntime(
		nodeDir = nodeDir,
		entityStore = entityStore,
		logger = ConsoleNodeLogger,
		signaling = resolveSignalingRuntimeConfig(),
		features = resolveP2PFeatures(),
	)
	runtime = created
	return created
}

/** @return 当前节点运行时 */
fun getNode(): NodeRuntime =
	runtime ?: throw IllegalStateException("p2p: node not initialized — call initNode() first")

/** @return 是否已调用 initNode */
fun isNodeInitialized(): Boolean = runtime != null

/** @param logger 节点日志器，null 表示静默 */
fun setNodeLogger(logger: NodeLogger?) {
	val current = runtime ?: throw IllegalStateException("p2p: setNodeLogger requires initNode")
	current.logger = logger
}

/** @param config signaling 运行时补丁 */
fun setSignalingRuntimeConfig(config: Map<String, Any?>?) {
	val current = runtime ?: throw IllegalStateException("p2p: setSignalingRuntimeConfig requires initNode")
	val previousPolicy = webrtcIceLocalHostnamePolicy(current.signaling)
	val merged = LinkedHashMap<String, Any?>(current.signaling)
	if (config != null) merged.putAll(config)
	val mergedChannels = LinkedHashMap<String, Any?>()
	val runtimeChannels = current.signaling["channels"] as? Map<*, *> ?: emptyMap<Any?, Any?>()
	for ((key, value) in runtimeChannels) if (key is String) mergedChannels[key] = value
	val configChannels = config?.get("channels") as? Map<*, *> ?: emptyMap<Any?, Any?>()
	for ((key, value) in configChannels) if (key is String) mergedChannels[key] = value
	merged["channels"] = mergedChannels
	current.signaling = resolveSignalingRuntimeConfig(merged)
	if (webrtcIceLocalHostnamePolicy(current.signaling) != previousPolicy) rtcPolyfillCacheEpoch++
	emitNodeChange("signaling-changed", current.signaling)
}

/** @return 当前 signaling 配置 */
fun getSignalingRuntimeConfig(): Map<String, Any?> = runtime?.signaling ?: defaultSignalingRuntimeConfig()

/** @param key signaling 配置 @return webrtc iceLocalHostnamePolicy */
private fun webrtcIceLocalHostnamePolicy(signaling: Map<String, Any?>?): Any? =
	Json.at(Json.at(Json.at(signaling, "channels"), "webrtc"), "iceLocalHostnamePolicy")

/** @param config feature 补丁 */
fun setP2PFeatures(config: Map<String, Any?>?) {
	val current = runtime ?: throw IllegalStateException("p2p: setP2PFeatures requires initNode")
	val merged = LinkedHashMap<String, Any?>(current.features)
	if (config != null) merged.putAll(config)
	current.features = resolveP2PFeatures(merged)
	emitNodeChange("features-changed", current.features)
}

/** @return 当前包级 feature map（副本） */
fun getP2PFeatures(): Map<String, Any?> = LinkedHashMap(getNode().features)

/** @return 节点数据目录绝对路径 */
fun getNodeDir(): String = getNode().nodeDir

/** @return 当前 entity store */
fun getEntityStore(): EntityStore = getNode().entityStore

/** @return 当前节点日志器 */
fun getNodeLogger(): NodeLogger? = runtime?.logger

/**
 * @param event 变更事件名
 * @param payload 事件载荷
 */
fun emitNodeChange(event: String, payload: Any? = JsonUndefined) {
	val listeners = synchronized(changeListenersGuard) { changeListeners.toList() }
	for (listener in listeners)
		try {
			listener(event, payload)
		}
		catch (_: Throwable) {
			// ignore
		}
}

/**
 * @param listener 变更回调
 * @return 取消监听的 dispose
 */
fun onNodeChange(listener: (String, Any?) -> Unit): () -> Unit {
	synchronized(changeListenersGuard) { changeListeners.add(listener) }
	return { synchronized(changeListenersGuard) { changeListeners.remove(listener) }; Unit }
}

/**
 * 关闭节点：释放全部文件句柄（chunk 读/写流等）并清空运行时与监听器。
 * 之后可用 initNode 重新引导。
 */
suspend fun closeNode() {
	runtime = null
	synchronized(changeListenersGuard) { changeListeners.clear() }
	rtcPolyfillCacheEpoch++
	closeAllFileStreams()
}
