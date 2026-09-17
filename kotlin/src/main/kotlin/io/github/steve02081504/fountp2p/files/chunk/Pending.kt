package io.github.steve02081504.fountp2p.files.chunk

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.base64ToBytes
import io.github.steve02081504.fountp2p.files.jsStringOr
import io.github.steve02081504.fountp2p.utils.FetchWaitHandle
import io.github.steve02081504.fountp2p.utils.FetchWaitTable

/**
 * chunk 拉取等待槽（等价 `files/chunk/pending.mjs`）。
 */

/** 并发 pending chunk fetch 上限。 */
const val MAX_PENDING_CHUNK_FETCHES: Int = 2048

private val table = FetchWaitTable<ByteArray?>(MAX_PENDING_CHUNK_FETCHES)

/** 入站 chunk 响应等待表（requestId → 等待条目）。 */
val pendingChunkFetches: LinkedHashMap<String, FetchWaitTable<ByteArray?>.Pending> = table.pending

/**
 * 注册 chunk 拉取等待槽（requestId 或 compositeKey）。
 * @param key 唯一等待键
 * @param expectedHash 期望 64 hex 密文哈希
 * @param timeoutMs 超时毫秒
 * @param options rejectOnTimeout 时 Promise 以 Error 拒绝
 * @return 等待句柄
 */
fun registerChunkFetchWait(
	key: String,
	expectedHash: String,
	timeoutMs: Long,
	options: Map<String, Any?>? = null,
): FetchWaitHandle<ByteArray?> =
	table.register(key, expectedHash, timeoutMs, options ?: emptyMap())

/**
 * 按等待键解析入站 chunk 响应（校验哈希后 resolve）。
 * @param key 等待键
 * @param expectedHash 期望哈希
 * @param bytes 密文块
 * @return 是否命中并完成等待
 */
fun resolveChunkFetchWait(key: String, expectedHash: String, bytes: ByteArray?): Boolean {
	val entry = table.peek(key) ?: return false
	if (entry.expectedKey != expectedHash) return false
	val verified = if (bytes != null) verifiedChunkBytes(expectedHash, bytes) else null
	if (bytes != null && verified == null) return false
	return table.settle(key, verified)
}

/**
 * 处理 fed_chunk_data / 带 requestId 的响应载荷。
 * @param payload 入站载荷
 * @return 是否命中 pending
 */
fun resolvePendingChunkFetch(payload: Any?): Boolean {
	val requestId = jsStringOr(Json.at(payload, "requestId"), "")
	if (requestId.isEmpty()) return false
	val entry = table.peek(requestId) ?: return false
	// 没有 dataBase64 不是“未找到”：不存在可信的负响应，任何收到 requestId 的 peer 都能拿空包提前判负。
	// 交给正常超时，让其它诚实响应者仍有机会提供块。
	val dataBase64 = Json.at(payload, "dataBase64")
	if (dataBase64 !is String) return false
	try {
		return resolveChunkFetchWait(requestId, entry.expectedKey, base64ToBytes(dataBase64))
	}
	catch (_: Throwable) {
		// keep waiting
	}
	return false
}
