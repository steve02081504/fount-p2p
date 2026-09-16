/**
 * Manifest 族路由：matcher 声明「该 manifest / 实体归哪个族（ownerId）所有」。
 * matcher 是唯一路由依据（注册序先命中者）；`transferKeyDescriptor.type` 可被多族复用、不参与路由。
 * 族间 matcher 必须互斥，否则按注册顺序先到先得。
 */

/** @type {Array<{ ownerId: string, match: (manifest: import('./normalize.mjs').FileManifest | null, ownerEntityHash: string) => boolean }>} */
const owners = []

/**
 * @param {string} ownerId 注册方
 * @param {(manifest: import('./normalize.mjs').FileManifest | null, ownerEntityHash: string) => boolean} match 归属判定
 * @returns {void}
 */
export function registerManifestOwner(ownerId, match) {
	owners.push({ ownerId, match })
}

/**
 * @param {string} ownerId 注册方
 * @returns {void}
 */
export function unregisterManifestOwner(ownerId) {
	for (let index = owners.length - 1; index >= 0; index--)
		if (owners[index].ownerId === ownerId) owners.splice(index, 1)
}

/**
 * 解析 manifest 归属族；无命中为 null（非 public 跨节点即 deny）。
 * @param {import('./normalize.mjs').FileManifest | null} manifest manifest（写路径可空）
 * @param {string} ownerEntityHash 所有者
 * @returns {string | null} 族 id
 */
export function resolveManifestOwner(manifest, ownerEntityHash) {
	for (const { ownerId, match } of owners)
		if (match(manifest, ownerEntityHash)) return ownerId
	return null
}
