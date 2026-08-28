/**
 * Manifest servicer 注册表：按 ACL 类型路由，决定跨节点是否对外提供非 public manifest。
 * 服务端缺省 deny；未注册的类型直接不响应 fed_manifest_get。
 */

/** @type {Map<string, { ownerId: string, handler: (context: ManifestServicerContext) => Promise<boolean> | boolean }>} */
const servicersByType = new Map()

/**
 * @typedef {{
 *   manifest: import('./normalize.mjs').FileManifest,
 *   ownerEntityHash: string,
 *   logicalPath: string,
 *   requesterNodeHash: string,
 *   peerId: string,
 *   payload: object,
 * }} ManifestServicerContext
 */

/**
 * @param {string} type ACL 类型（如 vault-wrap、file-master-key-wrap，或 resolveManifestAclType 匹配结果）
 * @param {string} ownerId 注册方
 * @param {(context: ManifestServicerContext) => Promise<boolean> | boolean} handler 授权判定
 * @returns {void}
 */
export function registerManifestServicer(type, ownerId, handler) {
	const existing = servicersByType.get(type)
	if (existing && existing.ownerId !== ownerId)
		throw new Error(`manifest servicer for '${type}' already registered by '${existing.ownerId}'`)
	servicersByType.set(type, { ownerId, handler })
}

/**
 * @param {string} type ACL 类型
 * @param {string} ownerId 注册方
 * @returns {void}
 */
export function unregisterManifestServicer(type, ownerId) {
	const existing = servicersByType.get(type)
	if (!existing) return
	if (existing.ownerId === ownerId)
		servicersByType.delete(type)
}

/**
 * @param {string} type ACL 类型
 * @returns {(context: ManifestServicerContext) => Promise<boolean> | boolean | undefined} 已注册 handler
 */
export function getManifestServicer(type) {
	return servicersByType.get(type)?.handler
}
