package io.github.steve02081504.fountp2p.trust_graph

import io.github.steve02081504.fountp2p.node.getLocalDataRevision

/**
 * 用户级信任图缓存（等价 `trust_graph/cache.mjs`）。
 *
 * 常态依赖 `node/local_data_revision` 失效；显式失效用于测试 / 特殊路径。
 */

/** 缓存条目：构建结果 + 构建时间 + 缓存自身 revision + 本机数据 revision。 */
private class CachedTrustGraph(
	val graph: Map<String, TrustNode>,
	val builtAt: Double,
	val revision: Double,
	val dataRevision: Double,
)

private val cacheByUsername = LinkedHashMap<String, CachedTrustGraph>()
private var revision = 0.0

private const val DEFAULT_TTL_MS = 30_000.0

/**
 * 显式失效（测试 / 特殊路径）；常态依赖 local_data_revision。
 */
fun invalidateTrustGraphCache() {
	cacheByUsername.clear()
	revision++
}

/**
 * @param username 副本用户名 登录名（缓存键，与 [buildMergedGraph] 一致）
 * @param build 构建函数
 * @param ttlMs TTL
 * @return 合并后的信任图
 */
suspend fun getCachedTrustGraph(
	username: String,
	build: suspend () -> Map<String, TrustNode>,
	ttlMs: Double = DEFAULT_TTL_MS,
): Map<String, TrustNode> {
	val now = System.currentTimeMillis().toDouble()
	val dataRevision = getLocalDataRevision()
	val cached = cacheByUsername[username]
	if (
		cached != null &&
		cached.revision == revision &&
		cached.dataRevision == dataRevision &&
		now - cached.builtAt < ttlMs
	)
		return cached.graph

	val graph = build()
	cacheByUsername[username] = CachedTrustGraph(graph, now, revision, dataRevision)
	return graph
}
