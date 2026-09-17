package io.github.steve02081504.fountp2p.files

import io.github.steve02081504.fountp2p.core.FEDERATION_CHUNK_MAX_BYTES
import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.crypto.randomBytes
import io.github.steve02081504.fountp2p.federation.jsTruthy
import java.security.MessageDigest

/**
 * 流式分块加密与解密（等价 `files/assemble_stream.mjs`）。
 *
 * 与 JS 的差异：JS 用 `node:stream` 的 Readable（含 `readStreamChunk` 的 readable/end 事件处理）；
 * Kotlin 以 [ByteChunkSource] 的拉取语义等价实现。
 */

/**
 * 从可读数据源分块加密并流式落盘（每块经 [onPart] 回调）。
 * @param readable 明文数据源
 * @param ceMode 加密模式
 * @param onPart 每块回调
 * @param maxBytes 最大字节
 * @return 分块结果
 */
suspend fun encryptReadableToParts(
	readable: ByteChunkSource,
	ceMode: String = "convergent",
	onPart: suspend (part: Map<String, Any?>) -> Unit,
	maxBytes: Double = Double.POSITIVE_INFINITY,
): EncryptPartsResult {
	val digest = MessageDigest.getInstance("SHA-256")
	var pending = ByteArray(0)
	val parts = ArrayList<Map<String, Any?>>()
	val contentKey = if (ceMode == "random") randomBytes(32) else null
	var total = 0.0
	val step = FEDERATION_CHUNK_MAX_BYTES.toInt()

	suspend fun flushSlice(slice: ByteArray) {
		digest.update(slice)
		val part = encryptSliceToPart(slice, ceMode, contentKey)
		val meta = LinkedHashMap<String, Any?>()
		meta["hash"] = part["hash"]
		meta["size"] = part["size"]
		if (jsTruthy(part["contentHash"])) meta["contentHash"] = part["contentHash"]
		parts.add(meta)
		onPart(part)
	}

	while (true) {
		val chunk = readable.read() ?: break
		total += chunk.size
		if (total > maxBytes)
			throw IllegalStateException("plaintext exceeds max upload size")
		pending += chunk
		while (pending.size >= step) {
			val slice = pending.copyOfRange(0, step)
			pending = pending.copyOfRange(step, pending.size)
			flushSlice(slice)
		}
	}

	if (pending.isNotEmpty())
		flushSlice(pending)

	return EncryptPartsResult(bytesToHex(digest.digest()), parts, contentKey)
}

/**
 * 将 manifest 各密文块按 part.size 拼齐后解密，串联为明文数据源。
 * @param manifest 清单
 * @param partStreams 按序密文数据源
 * @param contentKey 随机密钥
 * @return 明文数据源
 */
fun createManifestPlaintextStream(
	manifest: Map<String, Any?>,
	partStreams: List<ByteChunkSource>,
	contentKey: ByteArray?,
): ByteChunkSource {
	@Suppress("UNCHECKED_CAST")
	val parts = manifest["parts"] as? List<Any?> ?: emptyList()
	if (partStreams.size != parts.size)
		throw IllegalStateException("part stream count mismatch")
	return ManifestPlaintextStream(manifest, parts, partStreams, contentKey)
}

/** 解密拉取流：每次 [read] 产出一个 part 的明文，末尾校验 contentHash。 */
private class ManifestPlaintextStream(
	private val manifest: Map<String, Any?>,
	private val parts: List<Any?>,
	private val partStreams: List<ByteChunkSource>,
	private val contentKey: ByteArray?,
) : ByteChunkSource {
	private var partIndex = 0
	private var pending = ByteArray(0)
	private val digest = MessageDigest.getInstance("SHA-256")
	private var finished = false

	override suspend fun read(): ByteArray? {
		if (finished) return null
		try {
			while (partIndex < parts.size) {
				val part = parts[partIndex] as? Map<*, *>
				val need = jsNumberOr(part?.get("size"), 0.0).toInt()
				val stream = partStreams[partIndex]
				while (pending.size < need) {
					val more = stream.read() ?: break
					if (more.isNotEmpty()) pending += more
				}
				if (pending.size < need) throw IllegalStateException("short ciphertext part")
				val enc = pending.copyOfRange(0, need)
				pending = pending.copyOfRange(need, pending.size)
				if (pending.isNotEmpty()) throw IllegalStateException("trailing ciphertext in part stream")
				val plain = decryptPart(enc, manifest, contentKey, partIndex)
					?: throw IllegalStateException("decrypt failed")
				digest.update(plain)
				partIndex++
				return plain
			}
			if (jsTruthy(manifest["contentHash"])) {
				val got = bytesToHex(digest.digest())
				if (got != manifest["contentHash"]) throw IllegalStateException("contentHash mismatch")
			}
			finished = true
			return null
		}
		catch (error: Throwable) {
			finished = true
			throw error
		}
	}
}
