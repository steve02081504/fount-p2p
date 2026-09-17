package io.github.steve02081504.fountp2p.files.manifest

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.compositeKey
import io.github.steve02081504.fountp2p.files.jsStringOr
import io.github.steve02081504.fountp2p.utils.FetchWaitHandle
import io.github.steve02081504.fountp2p.utils.FetchWaitTable

/**
 * manifest 拉取等待槽（等价 `files/manifest/pending.mjs`）。
 */

/** 并发 pending manifest fetch 上限。 */
const val MAX_PENDING_MANIFEST_FETCHES: Int = 512

private val table = FetchWaitTable<Map<String, Any?>?>(MAX_PENDING_MANIFEST_FETCHES)

/** 入站 manifest 响应等待表（requestId → 等待条目）。 */
val pendingManifestFetches: LinkedHashMap<String, FetchWaitTable<Map<String, Any?>?>.Pending> = table.pending

/**
 * @param ownerEntityHash owner
 * @param logicalPath 路径
 * @return 期望键
 */
fun manifestFetchExpectedKey(ownerEntityHash: String, logicalPath: String): String =
	compositeKey(ownerEntityHash, logicalPath.replace(Regex("^/+"), ""))

/**
 * @param key requestId
 * @param expectedKey owner+path 复合键
 * @param timeoutMs 超时毫秒
 * @param options allowNonPublic 时接受无签名的非 public manifest（sender 须在 targetNodeHashes 内）
 * @return 等待句柄
 */
fun registerManifestFetchWait(
	key: String,
	expectedKey: String,
	timeoutMs: Long,
	options: Map<String, Any?>? = null,
): FetchWaitHandle<Map<String, Any?>?> =
	table.register(key, expectedKey, timeoutMs, options ?: emptyMap())

/**
 * 处理 fed_manifest_data：public 验签通过或（allowNonPublic 槽位）非 public 校验通过后 resolve pending。
 * @param payload 入站载荷
 * @return 是否命中并完成等待
 */
suspend fun resolvePendingManifestFetch(payload: Any?): Boolean {
	val requestId = jsStringOr(Json.at(payload, "requestId"), "")
	if (requestId.isEmpty()) return false
	val entry = table.peek(requestId) ?: return false

	val verified = verifySignedPublicManifest(Json.at(payload, "manifest"))
	if (verified != null) {
		val key = manifestFetchExpectedKey(
			verified["ownerEntityHash"] as String,
			verified["logicalPath"] as String,
		)
		if (key != entry.expectedKey) return false
		return table.settle(requestId, verified)
	}

	if (entry.options["allowNonPublic"] == true) {
		val normalized = normalizeFileManifest(Json.at(payload, "manifest"))
			?: return false
		val key = manifestFetchExpectedKey(
			normalized["ownerEntityHash"] as String,
			normalized["logicalPath"] as String,
		)
		if (key != entry.expectedKey) return false
		// 授权边界 = 目标集：无签名 manifest 仅接受来自目标节点集的响应。
		val targetNodeHashes = entry.options["targetNodeHashes"] as? List<*> ?: return false
		val senderNodeHash = Json.at(payload, "senderNodeHash")
		if (!targetNodeHashes.contains(senderNodeHash)) return false
		return table.settle(requestId, normalized)
	}

	return false
}
