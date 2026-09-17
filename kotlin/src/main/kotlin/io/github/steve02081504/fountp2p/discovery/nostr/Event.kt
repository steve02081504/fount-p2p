package io.github.steve02081504.fountp2p.discovery.nostr

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.core.hexToBytes
import io.github.steve02081504.fountp2p.crypto.randomBytes
import io.github.steve02081504.fountp2p.crypto.schnorrPublicKey
import io.github.steve02081504.fountp2p.crypto.schnorrSign
import io.github.steve02081504.fountp2p.crypto.sha256Hex
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Nostr 事件签名与发布（等价 `js/discovery/nostr/index.mjs` 中的
 * `signNostrEvent` / `publishEvent`）。
 */

/**
 * 构造并签名 Nostr 事件。
 *
 * `id = sha256(JSON.stringify([0, pubkey, created_at, kind, tags, content]))`，
 * `sig` 为对 `id` 的 BIP340 Schnorr 签名。
 * @param kind 事件 kind
 * @param tags 事件标签
 * @param content 事件内容
 * @param secretKey 32 字节 Schnorr 私钥
 * @param createdAt 秒级时间戳（默认当前时间）
 * @param auxRand 32 字节辅助随机数
 * @return 已签名的事件
 */
@JvmOverloads
fun signNostrEvent(
	kind: Int,
	tags: List<List<String>>,
	content: String,
	secretKey: ByteArray,
	createdAt: Long = System.currentTimeMillis() / 1000,
	auxRand: ByteArray = randomBytes(32),
): Map<String, Any?> {
	val pubkey = bytesToHex(schnorrPublicKey(secretKey))
	val serialized = Json.stringify(
		listOf(0.0, pubkey, createdAt.toDouble(), kind.toDouble(), tags, content),
	) ?: "null"
	val id = sha256Hex(serialized)
	val sig = bytesToHex(schnorrSign(hexToBytes(id), secretKey, auxRand))
	return linkedMapOf(
		"id" to id,
		"pubkey" to pubkey,
		"created_at" to createdAt.toDouble(),
		"kind" to kind.toDouble(),
		"tags" to tags,
		"content" to content,
		"sig" to sig,
	)
}

/**
 * 向全部中继并行发布事件；任一成功即算成功，全失败抛最后一个错误。
 * @param relayUrls 中继 URL 列表
 * @param event 待发布事件
 * @param signal 取消信号
 */
@JvmOverloads
suspend fun publishEvent(
	relayUrls: List<String>,
	event: Map<String, Any?>,
	signal: AbortSignalLike? = null,
) {
	val urls = dedupeRelayUrls(relayUrls)
	if (urls.isEmpty()) throw IllegalStateException("nostr: no relay")
	val published = AtomicBoolean(false)
	val lastError = AtomicReference<Throwable?>(null)
	coroutineScope {
		val jobs = urls.map { url ->
			async {
				try {
					val connectTarget = resolveRelayConnectTarget(url) ?: return@async
					if (publishViaSharedRelay(url, event, signal, connectTarget)) published.set(true)
				}
				catch (error: Throwable) {
					lastError.set(error)
				}
			}
		}
		for (job in jobs) job.await()
	}
	if (!published.get())
		throw lastError.get() ?: IllegalStateException("nostr: no relay accepted publish")
}
