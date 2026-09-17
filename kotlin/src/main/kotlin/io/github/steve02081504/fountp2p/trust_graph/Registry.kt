package io.github.steve02081504.fountp2p.trust_graph

/**
 * 用户级 P2P trust graph provider 注册表。
 *
 * 等价 `trust_graph/registry.mjs`。默认实现组合 `build.mjs` / `send.mjs`
 * （[createDefaultTrustGraphProvider]）。
 */

/** 信任图实现（等价 JS `TrustGraphProvider`）。 */
interface TrustGraphProvider {
	/**
	 * @param username 副本用户名 登录名
	 * @return nodeHash → 节点
	 */
	suspend fun buildMergedGraph(username: String): Map<String, TrustNode>

	/**
	 * @param username 副本用户名 登录名
	 * @param limit 最多返回节点数（缺省 12）
	 * @return 按信誉降序
	 */
	suspend fun pickTopNodes(
		username: String,
		limit: Int = TrustGraphTunables.pickTopNodesDefaultLimit.toInt(),
	): List<TrustNode>

	/**
	 * @param username 副本用户名 登录名
	 * @param targetNodeHash 64 位十六进制
	 * @param actionName action 名
	 * @param payload 载荷
	 * @param graph 已构建信任图（缺省内部构建）
	 * @return 是否已发送
	 */
	suspend fun sendToNode(
		username: String,
		targetNodeHash: String,
		actionName: String,
		payload: Any?,
		graph: Map<String, TrustNode>? = null,
	): Boolean

	/**
	 * @param username 副本用户名 登录名
	 * @param actionName action 名
	 * @param payload 载荷
	 * @param limit K（缺省按 roster 规模缩放）
	 * @return 发送次数
	 */
	suspend fun fanoutToTopNodes(
		username: String,
		actionName: String,
		payload: Any?,
		limit: Int? = null,
	): Int
}

/** 用户级 P2P trust graph（`registerTrustGraphProvider` 注册）。 */
const val DEFAULT_TRUST_GRAPH_OWNER: String = "default"

private val providersByOwner = LinkedHashMap<String, TrustGraphProvider>()

/**
 * @param ownerId 注册方（如 chat）
 * @param implementation 信任图实现
 */
fun registerTrustGraphProvider(ownerId: String, implementation: TrustGraphProvider) {
	providersByOwner[ownerId] = implementation
}

/** 清空全部已注册实现。 */
fun clearTrustGraphProvider() {
	providersByOwner.clear()
}

/**
 * @param ownerId 注册方 ID（缺省 [DEFAULT_TRUST_GRAPH_OWNER]）
 * @return 已注册实现
 */
fun requireTrustGraphProvider(ownerId: String = DEFAULT_TRUST_GRAPH_OWNER): TrustGraphProvider =
	providersByOwner[ownerId]
		?: throw IllegalStateException(
			"p2p: registerTrustGraphProvider('$ownerId') must run before trust graph fanout",
		)

/** @return 默认信任图实现（组合 `build.mjs` / `send.mjs`） */
fun createDefaultTrustGraphProvider(): TrustGraphProvider = object : TrustGraphProvider {
	override suspend fun buildMergedGraph(username: String): Map<String, TrustNode> =
		defaultTrustGraphBuild(username)

	override suspend fun pickTopNodes(username: String, limit: Int): List<TrustNode> =
		defaultTrustGraphPickTop(username, limit)

	override suspend fun sendToNode(
		username: String,
		targetNodeHash: String,
		actionName: String,
		payload: Any?,
		graph: Map<String, TrustNode>?,
	): Boolean = defaultTrustGraphSend(username, targetNodeHash, actionName, payload, graph)

	override suspend fun fanoutToTopNodes(
		username: String,
		actionName: String,
		payload: Any?,
		limit: Int?,
	): Int = defaultTrustGraphFanout(username, actionName, payload, limit)
}
