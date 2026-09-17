package io.github.steve02081504.fountp2p.files.chunk

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.assertHex64
import io.github.steve02081504.fountp2p.core.bytesToBase64
import io.github.steve02081504.fountp2p.federation.jsString
import io.github.steve02081504.fountp2p.federation.jsTruthy
import io.github.steve02081504.fountp2p.files.fed.beginFedFanoutFetch
import io.github.steve02081504.fountp2p.utils.InflightTable
import io.github.steve02081504.fountp2p.utils.ms

/**
 * chunk 拉取与入站服务（等价 `files/chunk/fetch.mjs`）。
 */

private val DEFAULT_CHUNK_FETCH_TIMEOUT_MS = ms("8s")

/** 同 username+hash 共享一次 fanout；队满只丢已超基础超时的队首。 */
private val chunkInflight = InflightTable<ByteArray?>(MAX_PENDING_CHUNK_FETCHES, DEFAULT_CHUNK_FETCH_TIMEOUT_MS)

/**
 * 拉取密文块。默认走 node-scope public 语义；
 * 传入 `fanoutTargets` 时只向目标集 fanout。
 * 同 username+hash+模式（含规范化目标集）in-flight 去重；本地已缓存块直接返回。
 * @param context 上下文
 * @return 密文块；失败为 null
 */
suspend fun fetchChunk(context: Map<String, Any?>): ByteArray? {
	val username = context["username"] as? String
	val hash = context["ciphertextHash"] as? String
	if (hash.isNullOrEmpty() || username.isNullOrEmpty()) return null

	if (hasChunk(hash))
		return getChunk(hash)

	if (jsTruthy(context["groupId"])) {
		val groupId = jsString(context["groupId"])
		val verified = verifiedChunkBytes(hash, fetchFederationChunk(username, groupId, hash))
		if (verified != null) {
			putChunk(hash, verified)
			return verified
		}
	}

	val shared = beginFedFanoutFetch(
		inflight = chunkInflight,
		inflightKeyBase = "$username\u0000$hash",
		username = username,
		action = "fed_chunk_get",
		registerWait = { requestId -> registerChunkFetchWait(requestId, hash, DEFAULT_CHUNK_FETCH_TIMEOUT_MS) },
		buildPayload = { requestId, nodeHash ->
			linkedMapOf(
				"requestId" to requestId,
				"nodeHash" to nodeHash,
				"chunkHash" to hash,
				"ownerEntityHash" to context["ownerEntityHash"],
			)
		},
		fanoutTargets = context["fanoutTargets"] as? List<*>,
	)
	if (shared == null) return null

	val verified = verifiedChunkBytes(hash, shared.await())
	if (verified != null) {
		putChunk(hash, verified)
		return verified
	}
	return null
}

/**
 * 若本机有 chunk 则响应 fed_chunk_get。
 *
 * 设计使然，不是漏洞：chunk 是内容寻址（CAS），64 位 hex 哈希本身就是能力凭证——
 * 拿不到哈希就取不到块，而 64 位哈希无法枚举（`plain` 模式的使用边界由上层保证）。
 *
 * @param payload 请求
 * @param sendResponse 发送
 * @param peerId 对端
 */
suspend fun handleIncomingChunkGet(
	payload: Any?,
	sendResponse: (response: Map<String, Any?>, peerId: String) -> Unit,
	peerId: String,
) {
	val hash = try {
		assertHex64(Json.at(payload, "chunkHash"), "chunkHash")
	}
	catch (_: Throwable) {
		return
	}
	if (!hasChunk(hash)) return
	val chunkBytes = getChunk(hash)
	if (chunkBytes.isEmpty()) return
	sendResponse(
		linkedMapOf(
			"requestId" to Json.at(payload, "requestId"),
			"dataBase64" to bytesToBase64(chunkBytes),
		),
		peerId,
	)
}
