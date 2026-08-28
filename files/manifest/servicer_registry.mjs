/**
 * Manifest servicer 注册表：按族（ownerId）路由，决定跨节点是否对外提供非 public manifest。
 * type 可被多族复用；路由只经 registerManifestOwner 的 matcher 唯一命中。服务端缺省 deny。
 */

/** @type {Map<string, (context: ManifestServicerContext) => Promise<boolean> | boolean>} */
const servicersByOwner = new Map()

/**
 * @typedef {{
 * 	manifest: import('./normalize.mjs').FileManifest,
 * 	ownerEntityHash: string,
 * 	logicalPath: string,
 * 	requesterNodeHash: string,
 * 	peerId: string,
 * 	payload: object,
 * }} ManifestServicerContext
 */

/**
 * @param {string} ownerId 注册方（族，须与 registerManifestOwner 一致）
 * @param {(context: ManifestServicerContext) => Promise<boolean> | boolean} handler 授权判定
 * @returns {void}
 */
export function registerManifestServicer(ownerId, handler) {
	servicersByOwner.set(ownerId, handler)
}

/**
 * @param {string} ownerId 注册方
 * @returns {void}
 */
export function unregisterManifestServicer(ownerId) {
	servicersByOwner.delete(ownerId)
}

/**
 * @param {string} ownerId 族 id
 * @returns {(context: ManifestServicerContext) => Promise<boolean> | boolean | undefined} 已注册 handler
 */
export function getManifestServicer(ownerId) {
	return servicersByOwner.get(ownerId)
}
