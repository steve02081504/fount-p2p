package io.github.steve02081504.fountp2p.files.manifest

/**
 * Manifest servicer 注册表：按族（ownerId）路由，决定跨节点是否对外提供非 public manifest。
 * type 可被多族复用；路由只经 registerManifestOwner 的 matcher 唯一命中。服务端缺省 deny。
 *
 * 等价 `files/manifest/servicer_registry.mjs`。
 */

/** servicer 上下文。 */
class ManifestServicerContext(
	/** 清单 */
	val manifest: Map<String, Any?>,
	/** 所有者 */
	val ownerEntityHash: String,
	/** 逻辑路径 */
	val logicalPath: String,
	/** 请求方 nodeHash（传输层认证） */
	val requesterNodeHash: String,
	/** 请求方 peerId */
	val peerId: String,
	/** 原始请求载荷 */
	val payload: Any?,
)

/** servicer 授权判定。 */
typealias ManifestServicer = suspend (ManifestServicerContext) -> Boolean

private val servicersByOwner = LinkedHashMap<String, ManifestServicer>()

/**
 * @param ownerId 注册方（族，须与 registerManifestOwner 一致）
 * @param handler 授权判定
 */
fun registerManifestServicer(ownerId: String, handler: ManifestServicer) {
	servicersByOwner[ownerId] = handler
}

/** @param ownerId 注册方 */
fun unregisterManifestServicer(ownerId: String) {
	servicersByOwner.remove(ownerId)
}

/**
 * @param ownerId 族 id
 * @return 已注册 handler；无则 null
 */
fun getManifestServicer(ownerId: String?): ManifestServicer? =
	if (ownerId == null) null else servicersByOwner[ownerId]
