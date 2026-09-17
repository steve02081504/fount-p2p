package io.github.steve02081504.fountp2p.link

import io.github.steve02081504.fountp2p.core.bytesToBase64
import io.github.steve02081504.fountp2p.core.bytesToHex
import io.github.steve02081504.fountp2p.core.hexToBytes
import io.github.steve02081504.fountp2p.core.toBytes
import io.github.steve02081504.fountp2p.crypto.randomBytes

/** frameId 字段字节长度（128 位）。 */
const val FRAME_ID_BYTES = 16

/** 帧头：frameId(16) + seq(4) + total(4)。 */
const val FRAME_HEADER_BYTES = FRAME_ID_BYTES + 4 + 4

/** 默认单帧最大 chunk 大小（15 KiB）。 */
const val DEFAULT_MAX_FRAME_CHUNK_BYTES = 15 * 1024

/** 重组后消息最大字节数（8 MiB）。 */
const val DEFAULT_MAX_MESSAGE_BYTES = 8 * 1024 * 1024

/** 同时进行中的分片消息数量上限。 */
const val DEFAULT_MAX_PARTIAL_MESSAGES = 32

/** 分片消息超时时间（毫秒）。 */
const val DEFAULT_PARTIAL_TIMEOUT_MS = 30_000

/**
 * @param frameId hex 或 16 字节
 * @return 规范化后的 16 字节 frameId
 */
private fun normalizeFrameIdBytes(frameId: Any?): ByteArray {
	if (frameId is ByteArray) {
		if (frameId.size != FRAME_ID_BYTES) throw IllegalArgumentException("p2p: frameId must be $FRAME_ID_BYTES bytes")
		return frameId
	}
	val text = frameId as? String ?: throw IllegalArgumentException("p2p: frameId must be 32 hex characters")
	if (text.length != FRAME_ID_BYTES * 2) throw IllegalArgumentException("p2p: frameId must be 32 hex characters")
	return try {
		hexToBytes(text)
	}
	catch (_: Exception) {
		throw IllegalArgumentException("p2p: frameId must be 32 hex characters")
	}
}

/** @return 32 字符 hex frameId */
fun randomFrameIdHex(): String = bytesToHex(randomBytes(FRAME_ID_BYTES))

/**
 * 在单包字符上限下，求单片最大可承载 chunk 字节数。
 *
 * 以 base64 逐片精确贴合上限为目标，用二分在 `[0, limit]` 内找最大 chunkBytes，
 * 使 `base64Len(headerBytes + chunkBytes) <= limit`。
 * @param maxPayloadChars 单包载荷字符上限（编码后）
 * @param encode 载荷编码函数（默认 base64）
 * @param headerBytes 帧头字节数
 * @return 最大 chunk 字节数（>=0）
 */
@JvmOverloads
fun maxFrameChunkBytesForPayload(
	maxPayloadChars: Any?,
	encode: (ByteArray) -> String = ::bytesToBase64,
	headerBytes: Int = FRAME_HEADER_BYTES,
): Int {
	val raw = (maxPayloadChars as? Number)?.toDouble() ?: 0.0
	val limit = maxOf(1, (if (raw.isNaN() || raw.isInfinite()) 0.0 else raw).toInt())
	var lowerBound = 0
	var upperBound = limit
	while (lowerBound < upperBound) {
		val candidateChunkBytes = (lowerBound + upperBound + 1) / 2
		if (encode(ByteArray(headerBytes + candidateChunkBytes)).length <= limit) lowerBound = candidateChunkBytes
		else upperBound = candidateChunkBytes - 1
	}
	return lowerBound
}

/**
 * @param frameId 消息 id（hex 或 16 字节）
 * @param bytes 消息体
 * @param maxChunkBytes 单片上限
 * @return 分片帧列表
 */
@JvmOverloads
fun encodeFrames(frameId: Any?, bytes: Any?, maxChunkBytes: Any? = DEFAULT_MAX_FRAME_CHUNK_BYTES): List<ByteArray> {
	val body = toBytes(bytes)
	val idBytes = normalizeFrameIdBytes(frameId)
	val requested = (maxChunkBytes as? Number)?.toInt() ?: 0
	val chunkBytes = minOf(DEFAULT_MAX_MESSAGE_BYTES, if (requested != 0) requested else DEFAULT_MAX_FRAME_CHUNK_BYTES)
	val total = maxOf(1, (body.size + chunkBytes - 1) / chunkBytes)
	val frames = ArrayList<ByteArray>(total)
	for (seq in 0 until total) {
		val start = seq * chunkBytes
		val end = minOf(body.size, start + chunkBytes)
		val chunk = body.copyOfRange(start, end)
		val frame = ByteArray(FRAME_HEADER_BYTES + chunk.size)
		System.arraycopy(idBytes, 0, frame, 0, FRAME_ID_BYTES)
		writeUInt32BE(frame, FRAME_ID_BYTES, seq)
		writeUInt32BE(frame, FRAME_ID_BYTES + 4, total)
		System.arraycopy(chunk, 0, frame, FRAME_HEADER_BYTES, chunk.size)
		frames.add(frame)
	}
	return frames
}

/** 解析后的帧字段。 */
data class DecodedFrame(val frameId: String, val seq: Int, val total: Int, val chunk: ByteArray) {
	override fun equals(other: Any?): Boolean =
		other is DecodedFrame && frameId == other.frameId && seq == other.seq && total == other.total &&
			chunk.contentEquals(other.chunk)

	override fun hashCode(): Int = ((frameId.hashCode() * 31 + seq) * 31 + total) * 31 + chunk.contentHashCode()
}

/**
 * 解析单帧头与 chunk。
 * @param frame 原始帧
 * @return 帧字段
 */
fun decodeFrame(frame: Any?): DecodedFrame {
	val bytes = toBytes(frame)
	if (bytes.size < FRAME_HEADER_BYTES) throw IllegalArgumentException("p2p: frame too short")
	val frameId = bytesToHex(bytes.copyOfRange(0, FRAME_ID_BYTES))
	val seq = readUInt32BE(bytes, FRAME_ID_BYTES)
	val total = readUInt32BE(bytes, FRAME_ID_BYTES + 4)
	if (total == 0 || seq >= total) throw IllegalArgumentException("p2p: invalid frame sequence")
	return DecodedFrame(frameId, seq, total, bytes.copyOfRange(FRAME_HEADER_BYTES, bytes.size))
}

private fun concatChunks(chunks: List<ByteArray?>): ByteArray {
	var totalBytes = 0
	for (chunk in chunks) totalBytes += chunk?.size ?: 0
	val out = ByteArray(totalBytes)
	var offset = 0
	for (chunk in chunks) {
		if (chunk == null) continue
		System.arraycopy(chunk, 0, out, offset, chunk.size)
		offset += chunk.size
	}
	return out
}

private fun writeUInt32BE(target: ByteArray, offset: Int, value: Int) {
	target[offset] = (value ushr 24).toByte()
	target[offset + 1] = (value ushr 16).toByte()
	target[offset + 2] = (value ushr 8).toByte()
	target[offset + 3] = value.toByte()
}

private fun readUInt32BE(source: ByteArray, offset: Int): Int =
	((source[offset].toInt() and 0xff) shl 24) or
		((source[offset + 1].toInt() and 0xff) shl 16) or
		((source[offset + 2].toInt() and 0xff) shl 8) or
		(source[offset + 3].toInt() and 0xff)

/**
 * 分片重组器（按 frameId 聚合，超时 prune），等价 JS `createReassembler`。
 * @param options 上限与超时
 */
class Reassembler(options: ReassemblerOptions = ReassemblerOptions()) {
	/** 重组器选项。 */
	data class ReassemblerOptions(
		val maxMessageBytes: Any? = null,
		val maxPartials: Any? = null,
		val partialTimeoutMs: Any? = null,
	)

	private class Partial(
		var total: Int,
		var remaining: Int,
		val chunks: Array<ByteArray?>,
		var bytes: Int,
		val firstSeenAt: Long,
		var lastSeenAt: Long,
	)

	private val maxMessageBytes = maxOf(1024, (options.maxMessageBytes as? Number)?.toInt() ?: DEFAULT_MAX_MESSAGE_BYTES)
	private val maxPartials = maxOf(1, (options.maxPartials as? Number)?.toInt() ?: DEFAULT_MAX_PARTIAL_MESSAGES)
	private val partialTimeoutMs =
		maxOf(1000L, (options.partialTimeoutMs as? Number)?.toLong() ?: DEFAULT_PARTIAL_TIMEOUT_MS.toLong())

	private val partials = LinkedHashMap<String, Partial>()

	/**
	 * 喂入一帧；凑齐则返回完整消息，否则 null。
	 * @param frame 原始帧
	 * @param now 当前时间戳（测试可注入）
	 * @return 完整消息或 null
	 */
	@JvmOverloads
	fun push(frame: Any?, now: Long = System.currentTimeMillis()): ByteArray? {
		val parsed = decodeFrame(frame)
		if (!partials.containsKey(parsed.frameId) && partials.size >= maxPartials)
			throw IllegalStateException("p2p: too many partial messages")
		var partial = partials[parsed.frameId]
		if (partial == null) {
			partial = Partial(
				total = parsed.total,
				remaining = parsed.total,
				chunks = arrayOfNulls(parsed.total),
				bytes = 0,
				firstSeenAt = now,
				lastSeenAt = now,
			)
			partials[parsed.frameId] = partial
		}
		if (partial.total != parsed.total) {
			partials.remove(parsed.frameId)
			throw IllegalStateException("p2p: frame total mismatch")
		}
		partial.lastSeenAt = now
		if (partial.chunks[parsed.seq] == null) {
			partial.chunks[parsed.seq] = parsed.chunk
			partial.remaining--
			partial.bytes += parsed.chunk.size
			if (partial.bytes > maxMessageBytes) {
				partials.remove(parsed.frameId)
				throw IllegalStateException("p2p: reassembled message exceeds limit")
			}
		}
		if (partial.remaining == 0) {
			val out = concatChunks(partial.chunks.toList())
			partials.remove(parsed.frameId)
			return out
		}
		return null
	}

	/**
	 * 丢弃超时未齐的分片。
	 * @param now 当前时间戳
	 * @return 被丢弃的 frameId 列表
	 */
	@JvmOverloads
	fun prune(now: Long = System.currentTimeMillis()): List<String> {
		val expired = ArrayList<String>()
		val iterator = partials.entries.iterator()
		while (iterator.hasNext()) {
			val (frameId, partial) = iterator.next()
			if (now - partial.lastSeenAt > partialTimeoutMs) {
				expired.add(frameId)
				iterator.remove()
			}
		}
		return expired
	}

	/** 清空全部分片状态。 */
	fun clear() = partials.clear()

	/** @return 进行中的分片消息数 */
	fun size(): Int = partials.size
}

/**
 * 创建分片重组器（等价 JS `createReassembler`）。
 * @param options 上限与超时
 * @return 重组 API
 */
@JvmOverloads
fun createReassembler(options: Reassembler.ReassemblerOptions = Reassembler.ReassemblerOptions()): Reassembler =
	Reassembler(options)
