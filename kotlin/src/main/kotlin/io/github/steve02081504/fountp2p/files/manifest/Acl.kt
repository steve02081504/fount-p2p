package io.github.steve02081504.fountp2p.files.manifest

import io.github.steve02081504.fountp2p.core.isLogicalEntityHash
import io.github.steve02081504.fountp2p.files.isWritableLocalEntity

/**
 * 本族 manifest 的本地读写授权判定（等价 `files/manifest/acl.mjs`）。
 */

/** ACL 上下文。 */
class ManifestAclContext(
	/** 请求 replica */
	val replicaUsername: String,
	/** 文件 owner */
	val ownerEntityHash: String,
	/** 清单 */
	val manifest: Any?,
)

/** ACL 授权判定：`(context, logicalPath?) => Promise<boolean>`。 */
typealias ManifestAclHandler = suspend (context: ManifestAclContext, logicalPath: String?) -> Boolean

private val aclHandlers = LinkedHashMap<String, ManifestAclHandler>()

/**
 * 注册本族 manifest 的本地读写授权判定（ownerId 须与 registerManifestOwner 一致）。
 * @param ownerId 注册方
 * @param handler 授权判定
 */
fun registerManifestAcl(ownerId: String, handler: ManifestAclHandler) {
	aclHandlers[ownerId] = handler
}

/** @param ownerId 注册方 */
fun unregisterManifestAcl(ownerId: String) {
	aclHandlers.remove(ownerId)
}

/**
 * 本地读授权：仅认 matcher 结果——命中族须注册 ACL handler，否则 deny。
 * @param replicaUsername 请求 replica
 * @param ownerEntityHash 文件 owner
 * @param manifest 清单
 * @return 是否允许读
 */
suspend fun canReadManifest(replicaUsername: String, ownerEntityHash: String, manifest: Any?): Boolean {
	val ownerId = resolveManifestOwner(manifest, ownerEntityHash)
	if (ownerId != null) {
		val handler = aclHandlers[ownerId]
		if (handler != null) return handler(ManifestAclContext(replicaUsername, ownerEntityHash, manifest), null)
		return false
	}
	return !isLogicalEntityHash(ownerEntityHash)
}

/**
 * 本地写授权：仅认 matcher 结果（写路径无 manifest，只按 ownerEntityHash 判定）。
 * @param replicaUsername 请求 replica
 * @param ownerEntityHash 所有者
 * @param logicalPath 路径
 * @return 是否允许写
 */
suspend fun canWriteManifestPath(replicaUsername: String, ownerEntityHash: String, logicalPath: String): Boolean {
	val ownerId = resolveManifestOwner(null, ownerEntityHash)
	if (ownerId != null) {
		val handler = aclHandlers[ownerId]
		if (handler != null)
			return handler(ManifestAclContext(replicaUsername, ownerEntityHash, emptyMap<String, Any?>()), logicalPath)
		return false
	}
	return !isLogicalEntityHash(ownerEntityHash) && isWritableLocalEntity(ownerEntityHash)
}
