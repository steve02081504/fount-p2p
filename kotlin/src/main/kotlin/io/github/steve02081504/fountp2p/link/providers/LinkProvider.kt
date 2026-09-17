package io.github.steve02081504.fountp2p.link.providers

import kotlinx.coroutines.CompletableDeferred

/**
 * 上层（rooms / federation / shell）可见的链路句柄。
 *
 * 不暴露 RTC DataChannel、ICE、GATT 等传输细节；providerId/level/initiator 仅供包内择链。
 */
interface LinkHandle {
	/** 握手完成后 resolve。 */
	val ready: CompletableDeferred<Unit>

	/** 对端 nodeHash（握手后）。 */
	val nodeHash: String?

	/** 是否发起方。 */
	val initiator: Boolean

	/** 提供者 id。 */
	val providerId: String

	/** 提供者 level。 */
	val level: Double

	/**
	 * 发送业务 envelope。
	 * @param envelope 信封
	 * @return 是否发送成功
	 */
	suspend fun send(envelope: Map<String, Any?>): Boolean

	/**
	 * @param callback 回调
	 * @return 取消订阅
	 */
	fun onEnvelope(callback: (Map<String, Any?>, String) -> Unit): () -> Unit

	/**
	 * @param callback 回调
	 * @return 取消订阅
	 */
	fun onDown(callback: (String) -> Unit): () -> Unit

	/** @return 运行时统计 */
	fun stats(): Map<String, Any?>

	/**
	 * 关闭 pipe 与底层传输。
	 * @param reason 关闭原因
	 */
	suspend fun close(reason: String = "closed")
}

/**
 * 链路提供者（平台抽象：Android 无 WebRTC/TCP/BLE 原生 API，由具体实现注入）。
 */
interface LinkProvider {
	/** 提供者 id。 */
	val id: String

	/** 数值越大越优先。 */
	val level: Double

	/** 能力声明（可选）。 */
	val caps: Map<String, Any?>? get() = null

	/** @return 是否可用 */
	suspend fun isAvailable(): Boolean

	/**
	 * @param remote 远端 `{ nodeHash, hints? }`
	 * @return 是否可达
	 */
	fun canReach(remote: Map<String, Any?>): Boolean = true

	/**
	 * @param options dial 选项
	 * @return link 或 null
	 */
	suspend fun dial(options: Map<String, Any?>): LinkHandle?

	/**
	 * @param options accept 选项
	 * @return link 或 null
	 */
	suspend fun accept(options: Map<String, Any?>): LinkHandle? = null

	/**
	 * @param onInbound 入站回调
	 * @param localIdentity 本地身份
	 * @return 停止 listening
	 */
	suspend fun ensureListening(onInbound: (LinkHandle) -> Unit, localIdentity: Map<String, Any?>): (() -> Unit)? = null

	/** @return 本机 listen 端点 */
	fun localEndpoint(): Map<String, Any?>? = null
}

private val providers = LinkedHashMap<String, LinkProvider>()

/**
 * 注册 link provider。
 * @param provider 链路提供者
 * @return 注销函数
 */
fun registerLinkProvider(provider: LinkProvider): () -> Unit {
	if (provider.id.isEmpty()) throw IllegalArgumentException("p2p: link provider requires id")
	providers[provider.id] = provider
	return { unregisterLinkProvider(provider.id) }
}

/**
 * 注销 link provider。
 * @param id 提供者 id
 */
fun unregisterLinkProvider(id: String) {
	providers.remove(id)
}

/** @return 已注册的 link provider（按 level 降序） */
fun listLinkProviders(): List<LinkProvider> =
	providers.values.sortedByDescending { it.level }

/** 清空全部 link provider。 */
fun clearLinkProviders() {
	providers.clear()
}

/** @return 当前可用的 link provider（isAvailable 失败视为不可用；按 level 降序） */
suspend fun listAvailableLinkProviders(): List<LinkProvider> =
	listLinkProviders().mapNotNull { provider ->
		try {
			if (provider.isAvailable()) provider else null
		}
		catch (_: Exception) {
			null
		}
	}
