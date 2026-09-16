package io.github.steve02081504.fountp2p.federation

/**
 * VOLATILE 流：`stream_chunk` 按 chunkSeq 缓冲 slices JSON；终稿由 DAG message_edit 结束（§6.4）。
 */

/**
 * 单个分片。
 * @param chunkSeq 分片序号
 * @param payload JSON 序列化的 slices
 */
data class VolatileChunk(val chunkSeq: Double, val payload: String)

/**
 * @return 含 addChunk/end/listChunks/clear 的流缓冲
 */
fun createVolatileStreamBuffer(): VolatileStreamBuffer = VolatileStreamBuffer()

/** `stream_chunk` 缓冲。 */
class VolatileStreamBuffer {
	private class Stream(val chunks: LinkedHashMap<Double, String> = LinkedHashMap(), var ended: Boolean = false)

	private val streams = HashMap<String, Stream>()

	/**
	 * @param pendingStreamId 流 ID
	 * @param chunkSeq 分片序号
	 * @param payload JSON 序列化的 slices
	 */
	fun addChunk(pendingStreamId: String, chunkSeq: Double, payload: String) {
		val stream = streams.getOrPut(pendingStreamId) { Stream() }
		if (!stream.ended) stream.chunks[chunkSeq] = payload
	}

	/**
	 * @param pendingStreamId 流 ID
	 */
	fun end(pendingStreamId: String) {
		streams[pendingStreamId]?.ended = true
	}

	/**
	 * @param pendingStreamId 流 ID
	 * @return 升序分片列表
	 */
	fun listChunks(pendingStreamId: String): List<VolatileChunk> {
		val stream = streams[pendingStreamId] ?: return emptyList()
		return stream.chunks.entries.sortedBy { it.key }.map { VolatileChunk(it.key, it.value) }
	}

	/**
	 * @param pendingStreamId 流 ID
	 */
	fun clear(pendingStreamId: String) {
		streams.remove(pendingStreamId)
	}
}
