package io.github.steve02081504.fountp2p.files.manifest

/**
 * Manifest 族路由：matcher 声明「该 manifest / 实体归哪个族（ownerId）所有」。
 * matcher 是唯一路由依据（注册序先命中者）；`transferKeyDescriptor.type` 可被多族复用、不参与路由。
 * 族间 matcher 必须互斥，否则按注册顺序先到先得。
 *
 * 等价 `files/manifest/routing.mjs`。
 */

/** 族归属判定：`(manifest, ownerEntityHash) => boolean`（写路径 manifest 可为 null）。 */
typealias ManifestOwnerMatcher = (manifest: Any?, ownerEntityHash: String) -> Boolean

private data class OwnerEntry(val ownerId: String, val match: ManifestOwnerMatcher)

private val owners = ArrayList<OwnerEntry>()

/**
 * @param ownerId 注册方
 * @param match 归属判定
 */
fun registerManifestOwner(ownerId: String, match: ManifestOwnerMatcher) {
	owners.add(OwnerEntry(ownerId, match))
}

/** @param ownerId 注册方 */
fun unregisterManifestOwner(ownerId: String) {
	for (index in owners.indices.reversed())
		if (owners[index].ownerId == ownerId) owners.removeAt(index)
}

/**
 * 解析 manifest 归属族；无命中为 null（非 public 跨节点即 deny）。
 * @param manifest manifest（写路径可空）
 * @param ownerEntityHash 所有者
 * @return 族 id
 */
fun resolveManifestOwner(manifest: Any?, ownerEntityHash: String): String? {
	for (entry in owners) if (entry.match(manifest, ownerEntityHash)) return entry.ownerId
	return null
}
