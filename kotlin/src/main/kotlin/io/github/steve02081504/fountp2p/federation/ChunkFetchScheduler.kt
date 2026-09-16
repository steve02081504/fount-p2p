package io.github.steve02081504.fountp2p.federation

/**
 * 联邦分块拉取调度：按 peer 轮转分配缺失块，支持超时重试与广播兜底。
 */

/** 拉取状态：`pending` / `inflight` / `done` / `failed`。 */
data class ChunkFetchRow(val state: String, val peerId: String?, val attempts: Int)

/** 分配结果。 */
data class ChunkFetchPlan(val assignments: LinkedHashMap<String, String>, val broadcast: List<String>)

/** 进度统计。 */
data class ChunkFetchProgress(val done: Int, val pending: Int, val inflight: Int, val failed: Int, val total: Int)

/**
 * @param chunkHashes 缺失块哈希（有序）
 * @param peerIds 可用 peerId 列表
 * @return chunkHash → 首选 peerId
 */
fun assignChunksToPeers(chunkHashes: List<String>, peerIds: List<String>): LinkedHashMap<String, String> {
	val out = LinkedHashMap<String, String>()
	if (peerIds.isEmpty()) return out
	val list = peerIds.filter { it.isNotEmpty() }
	if (list.isEmpty()) return out
	for (index in chunkHashes.indices) out[chunkHashes[index]] = list[index % list.size]
	return out
}

/**
 * @param table 状态表
 * @param chunkHashes 待拉取块
 * @param peerIds 可用 peer
 * @param maxAttempts 最大尝试次数
 * @return 分配与需广播块
 */
fun planChunkFetches(
	table: MutableMap<String, ChunkFetchRow>,
	chunkHashes: List<String>,
	peerIds: List<String>,
	maxAttempts: Any? = null,
): ChunkFetchPlan {
	val cap = maxOf(1.0, jsNumberOr(jsNumber(maxAttempts), 3.0))
	val assignments = assignChunksToPeers(chunkHashes, peerIds)
	val broadcast = mutableListOf<String>()
	for (hash in chunkHashes) {
		val row = table[hash] ?: ChunkFetchRow("pending", null, 0)
		if (row.state == "done") continue
		if (row.state == "inflight") continue
		if (row.attempts >= cap) {
			broadcast.add(hash)
			continue
		}
		if (assignments[hash] == null) broadcast.add(hash)
	}
	return ChunkFetchPlan(assignments, broadcast)
}

/**
 * @param table 状态表
 * @param chunkHash 块哈希
 * @param peerId 目标 peer
 */
fun markChunkInflight(table: MutableMap<String, ChunkFetchRow>, chunkHash: String, peerId: String) {
	val prev = table[chunkHash] ?: ChunkFetchRow("pending", null, 0)
	table[chunkHash] = ChunkFetchRow("inflight", peerId, prev.attempts + 1)
}

/**
 * @param table 状态表
 * @param chunkHash 块哈希
 */
fun markChunkDone(table: MutableMap<String, ChunkFetchRow>, chunkHash: String) {
	table[chunkHash] = ChunkFetchRow("done", null, 0)
}

/**
 * @param table 状态表
 * @param chunkHash 块哈希
 */
fun markChunkFailed(table: MutableMap<String, ChunkFetchRow>, chunkHash: String) {
	val prev = table[chunkHash] ?: ChunkFetchRow("pending", null, 0)
	table[chunkHash] = ChunkFetchRow("failed", null, prev.attempts)
}

/**
 * @param table 状态表
 * @return 进度
 */
fun chunkFetchProgress(table: Map<String, ChunkFetchRow>): ChunkFetchProgress {
	var done = 0
	var pending = 0
	var inflight = 0
	var failed = 0
	for (row in table.values) {
		when (row.state) {
			"done" -> done++
			"inflight" -> inflight++
			"failed" -> failed++
			else -> pending++
		}
	}
	return ChunkFetchProgress(done, pending, inflight, failed, table.size)
}
