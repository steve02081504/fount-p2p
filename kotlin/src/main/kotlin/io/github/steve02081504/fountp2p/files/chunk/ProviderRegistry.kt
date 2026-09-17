package io.github.steve02081504.fountp2p.files.chunk

/**
 * 联邦 chunk 拉取 provider 注册表（等价 `files/chunk/provider_registry.mjs`）。
 */

/** 联邦 chunk 拉取函数。 */
typealias FederationChunkFetcher = suspend (username: String, groupId: String, hash: String) -> ByteArray?

/** nodeHash provider 函数。 */
typealias NodeHashProvider = suspend (username: String) -> Map<String, Any?>

private val federationFetchersByOwner = LinkedHashMap<String, FederationChunkFetcher>()

private val nodeHashProvidersByOwner = LinkedHashMap<String, NodeHashProvider>()

/**
 * @param ownerId 注册方
 * @param fetcher 联邦 chunk 拉取
 */
fun registerFederationChunkFetcher(ownerId: String, fetcher: FederationChunkFetcher) {
	federationFetchersByOwner[ownerId] = fetcher
}

/**
 * @param ownerId 注册方
 * @param provider nodeHash
 */
fun registerNodeHashProvider(ownerId: String, provider: NodeHashProvider) {
	nodeHashProvidersByOwner[ownerId] = provider
}

/** @param ownerId 注册方 */
fun unregisterChunkProviders(ownerId: String) {
	federationFetchersByOwner.remove(ownerId)
	nodeHashProvidersByOwner.remove(ownerId)
}

/**
 * @param username 用户
 * @param groupId 群 ID
 * @param hash chunk 哈希
 * @return 密文块；无命中为 null
 */
suspend fun fetchFederationChunk(username: String, groupId: String, hash: String): ByteArray? {
	for (fetcher in federationFetchersByOwner.values)
		try {
			val bytes = fetcher(username, groupId, hash)
			if (bytes != null && bytes.isNotEmpty()) return bytes
		}
		catch (_: Throwable) {
			// next
		}
	return null
}

/**
 * @param username 副本用户名 登录名
 * @return 节点标识
 */
suspend fun resolveNodeHash(username: String): Map<String, Any?> {
	for (provider in nodeHashProvidersByOwner.values)
		try {
			return provider(username)
		}
		catch (_: Throwable) {
			// next
		}
	return linkedMapOf("nodeHash" to "local")
}
