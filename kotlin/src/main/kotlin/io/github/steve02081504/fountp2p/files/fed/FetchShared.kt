package io.github.steve02081504.fountp2p.files.fed

import io.github.steve02081504.fountp2p.files.canonicalizeFanoutTargets
import io.github.steve02081504.fountp2p.files.chunk.resolveNodeHash
import io.github.steve02081504.fountp2p.files.fanoutFedFetch
import io.github.steve02081504.fountp2p.utils.FetchWaitHandle
import io.github.steve02081504.fountp2p.utils.InflightTable
import io.github.steve02081504.fountp2p.utils.Started
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * inflight + pending wait + fanout 共用骨架（等价 `files/fed/fetch_shared.mjs`）。
 *
 * 规范化目标集并拼入 inflight key：`fanoutTargets` 非 null 即定向模式，null 为 node-scope public 模式。
 */

/** 后台 fanout 协程作用域（等价 JS 的 `void (async () => ...)()`）。 */
private val fedFanoutScope = CoroutineScope(Dispatchers.Default + SupervisorJob())

/**
 * @param inflight 在飞去重表
 * @param inflightKeyBase in-flight key 前缀
 * @param username 用户
 * @param action wire action 名
 * @param registerWait 注册 pending 等待
 * @param buildPayload 构造 fanout 载荷
 * @param fanoutTargets 目标集（非 null 即定向模式）
 * @return 共享结果；队满为 null
 */
fun <T> beginFedFanoutFetch(
	inflight: InflightTable<T>,
	inflightKeyBase: String,
	username: String,
	action: String,
	registerWait: (requestId: String) -> FetchWaitHandle<T>,
	buildPayload: (requestId: String, nodeHash: String) -> Any?,
	fanoutTargets: List<*>? = null,
): Deferred<T>? {
	val targeted = fanoutTargets != null
	val canonicalTargets = if (targeted) canonicalizeFanoutTargets(fanoutTargets) else null
	val targetsSuffix =
		if (!canonicalTargets.isNullOrEmpty()) "\u0000" + canonicalTargets.joinToString("\u0000") else ""
	val inflightKey = "$inflightKeyBase\u0000${if (targeted) "targeted" else "public"}$targetsSuffix"
	return inflight.acquire(inflightKey) {
		val requestId = UUID.randomUUID().toString()
		val wait = registerWait(requestId)
		fedFanoutScope.launch {
			try {
				val resolved = resolveNodeHash(username)
				val nodeHash = resolved["nodeHash"]?.toString() ?: "local"
				fanoutFedFetch(username, action, buildPayload(requestId, nodeHash), canonicalTargets)
			}
			catch (_: Throwable) {
				// pending wait 超时/cancel 负责 settle
			}
		}
		@Suppress("UNCHECKED_CAST")
		Started(wait.done as Deferred<T>, wait.cancel)	}
}
