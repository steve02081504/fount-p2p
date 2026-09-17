package io.github.steve02081504.fountp2p.files.manifest

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.assertSafeEvfsLogicalPath
import io.github.steve02081504.fountp2p.core.parseEntityHash
import io.github.steve02081504.fountp2p.federation.jsNumber
import io.github.steve02081504.fountp2p.federation.jsString
import io.github.steve02081504.fountp2p.federation.jsTruthy
import io.github.steve02081504.fountp2p.files.canonicalizeFanoutTargets
import io.github.steve02081504.fountp2p.files.fed.beginFedFanoutFetch
import io.github.steve02081504.fountp2p.files.isWritableLocalEntity
import io.github.steve02081504.fountp2p.files.jsStringOr
import io.github.steve02081504.fountp2p.files.loadFileManifest
import io.github.steve02081504.fountp2p.files.saveFileManifest
import io.github.steve02081504.fountp2p.node.getEntityStore
import io.github.steve02081504.fountp2p.utils.InflightTable
import io.github.steve02081504.fountp2p.utils.ms
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * manifest 拉取与入站服务（等价 `files/manifest/fetch.mjs`）。
 */

/** SWR 后台刷新协程作用域：等价 JS `void shared.then(...)` 的游离 promise。 */
private val manifestRefreshScope = CoroutineScope(Dispatchers.Default + SupervisorJob())

private val DEFAULT_MANIFEST_FETCH_TIMEOUT_MS = ms("8s")

/** 同 username+owner+path+模式 共享一次 fanout；队满只丢已超基础超时的队首。 */
private val manifestInflight = InflightTable<Map<String, Any?>?>(
	MAX_PENDING_MANIFEST_FETCHES,
	DEFAULT_MANIFEST_FETCH_TIMEOUT_MS,
)

/**
 * 拉取 manifest。默认走 node-scope public 语义（仅接受验签公开 manifest）；
 * 传入 `fanoutTargets` 时只向目标集 fanout，并接受无签名的非 public manifest。
 * @param context 拉取上下文
 * @return 校验后的 manifest；失败为 null
 */
suspend fun fetchManifest(context: Map<String, Any?>): Map<String, Any?>? = coroutineScope {
	val ownerEntityHash = context["ownerEntityHash"] as? String
	val username = context["username"] as? String
	val rawPath = context["logicalPath"]
	val logicalPath = (if (rawPath is String) rawPath else jsString(rawPath)).replace(Regex("^/+"), "")
	if (ownerEntityHash.isNullOrEmpty() || logicalPath.isEmpty() || username.isNullOrEmpty())
		return@coroutineScope null

	val revalidate = context["revalidate"] == true
	val timeoutMs = if (jsNumber(context["timeoutMs"]) > 0)
		jsNumber(context["timeoutMs"]).toLong()
	else DEFAULT_MANIFEST_FETCH_TIMEOUT_MS
	val expectedKey = manifestFetchExpectedKey(ownerEntityHash, logicalPath)
	val wantCache = context["cache"] == true
	val targeted = context["fanoutTargets"] is List<*>
	val fanoutTargets = if (targeted) canonicalizeFanoutTargets(context["fanoutTargets"] as List<*>) else null

	// 先同步挂 in-flight，再读本地 — 避免并发调用在 await 间隙各自 start（本地慢读可能晚于对端结算）。
	val localDeferred = async { loadFileManifest(ownerEntityHash, logicalPath) }
	val shared = beginFedFanoutFetch(
		inflight = manifestInflight,
		inflightKeyBase = "$username\u0000$expectedKey",
		username = username,
		action = "fed_manifest_get",
		registerWait = { requestId ->
			registerManifestFetchWait(
				requestId,
				expectedKey,
				timeoutMs,
				if (targeted) mapOf("allowNonPublic" to true, "targetNodeHashes" to fanoutTargets) else null,
			)
		},
		buildPayload = { requestId, _ ->
			linkedMapOf(
				"requestId" to requestId,
				"ownerEntityHash" to ownerEntityHash,
				"logicalPath" to logicalPath,
			)
		},
		fanoutTargets = fanoutTargets,
	)
	val local = localDeferred.await()

	// 本地已验签公开命中：默认立即返回，cache: true 时后台 fanout 择新刷新；
	// revalidate: true 时阻塞等待本次 fanout，取新择旧并写回，fanout 无新（含超时）则回退本地。
	val localDescriptor = local?.get("transferKeyDescriptor") as? Map<*, *>
	val isLocalPublic = localDescriptor?.get("type") == "public" &&
		jsTruthy(Json.at(Json.at(local, "meta"), "publicSig"))
	if (isLocalPublic) {
		if (shared != null && revalidate) {
			val result = shared.await()
			if (result != null && shouldPreferIncomingPublicManifest(local, result)) {
				if (wantCache) cachePublicManifest(ownerEntityHash, logicalPath, result)
				return@coroutineScope result
			}
		}
		else if (wantCache && shared != null) {
			manifestRefreshScope.launch {
				val result = shared.await()
				if (result != null && shouldPreferIncomingPublicManifest(local, result))
					cachePublicManifest(ownerEntityHash, logicalPath, result)
			}
		}
		return@coroutineScope local
	}

	// 本地非 public / 未验签 public 命中：仅 targeted 模式返回（授权边界 = 目标集）；public 模式拒绝。
	if (local != null) return@coroutineScope if (targeted) local else null

	if (shared == null) return@coroutineScope null

	val result = shared.await() ?: return@coroutineScope null
	val resultDescriptor = result["transferKeyDescriptor"] as? Map<*, *>
	if (wantCache || targeted) {
		if (resultDescriptor?.get("type") == "public")
			cachePublicManifest(ownerEntityHash, logicalPath, result)
		else if (!isWritableLocalEntity(ownerEntityHash))
			saveFileManifest(result)
	}

	return@coroutineScope result
}

/**
 * 将已验签公开 manifest 写入本地缓存（显式 apply；`fetchManifest` public 模式默认不调用）。
 * @param ownerEntityHash owner
 * @param logicalPath 路径
 * @param incoming 已验签入站清单
 */
suspend fun cachePublicManifest(
	ownerEntityHash: String,
	logicalPath: String,
	incoming: Map<String, Any?>,
) {
	if (isWritableLocalEntity(ownerEntityHash)) return
	val existing = getEntityStore().readManifest(ownerEntityHash, logicalPath)
	if (existing != null && !shouldPreferIncomingPublicManifest(existing, incoming)) return
	saveFileManifest(incoming)
}

/**
 * 响应 fed_manifest_get：public 只回验签公开清单；非 public 经 ACL servicer 授权后回完整清单。
 * @param payload 请求
 * @param sendResponse 发送
 * @param peerId 对端（传输层认证的发送方 nodeHash，即 requesterNodeHash）
 */
suspend fun handleIncomingManifestGet(
	payload: Any?,
	sendResponse: (response: Map<String, Any?>, peerId: String) -> Unit,
	peerId: String,
) {
	val parsedOwner = parseEntityHash(Json.at(payload, "ownerEntityHash")) ?: return
	val logicalPath = try {
		assertSafeEvfsLogicalPath(Json.at(payload, "logicalPath") as? String)
	}
	catch (_: Throwable) {
		return
	}
	val requestId = jsStringOr(Json.at(payload, "requestId"), "")
	if (requestId.isEmpty()) return
	val ownerEntityHash = parsedOwner.entityHash

	val raw = getEntityStore().readManifest(ownerEntityHash, logicalPath)
	val manifest = normalizeFileManifest(raw) ?: return

	val descriptor = manifest["transferKeyDescriptor"] as? Map<*, *>
	if (descriptor?.get("type") == "public") {
		val publicSig = raw?.let { Json.at(Json.at(it, "meta"), "publicSig") }
		if (!jsTruthy(publicSig)) return
		sendResponse(
			linkedMapOf(
				"requestId" to requestId,
				"manifest" to linkedMapOf<String, Any?>().apply {
					putAll(manifest)
					this["meta"] = linkedMapOf("publicSig" to publicSig)
				},
			),
			peerId,
		)
		return
	}

	// 非 public：仅认 matcher 命中的族 servicer（无 matcher 即 deny，不按 transferKeyDescriptor.type 兜底路由）。
	val ownerId = resolveManifestOwner(manifest, ownerEntityHash)
	val servicer = getManifestServicer(ownerId) ?: return
	val allowed = servicer(
		ManifestServicerContext(
			manifest = manifest,
			ownerEntityHash = ownerEntityHash,
			logicalPath = logicalPath,
			requesterNodeHash = peerId,
			peerId = peerId,
			payload = payload,
		),
	)
	if (!allowed) return
	sendResponse(linkedMapOf("requestId" to requestId, "manifest" to manifest), peerId)
}
