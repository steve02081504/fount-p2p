import { isLogicalEntityHash } from '../../core/logical_entity.mjs'
import { isWritableLocalEntity } from '../../node/identity.mjs'

import { resolveManifestOwner } from './routing.mjs'

/**
 * @typedef {{
 *   replicaUsername: string,
 *   ownerEntityHash: string,
 *   manifest: import('./normalize.mjs').FileManifest | object,
 * }} ManifestAclContext
 */

/** @type {Map<string, (context: ManifestAclContext, logicalPath?: string) => Promise<boolean>>} */
const aclHandlers = new Map()

/**
 * 注册本族 manifest 的本地读写授权判定（ownerId 须与 registerManifestOwner 一致）。
 * @param {string} ownerId 注册方
 * @param {(context: ManifestAclContext, logicalPath?: string) => Promise<boolean>} handler 授权判定
 * @returns {void}
 */
export function registerManifestAcl(ownerId, handler) {
	aclHandlers.set(ownerId, handler)
}

/**
 * @param {string} ownerId 注册方
 * @returns {void}
 */
export function unregisterManifestAcl(ownerId) {
	aclHandlers.delete(ownerId)
}

/**
 * 本地读授权：仅认 matcher 结果——命中族须注册 ACL handler，否则 deny。
 * @param {string} replicaUsername 请求 replica
 * @param {string} ownerEntityHash 文件 owner
 * @param {import('./normalize.mjs').FileManifest} manifest 清单
 * @returns {Promise<boolean>} 是否允许读
 */
export async function canReadManifest(replicaUsername, ownerEntityHash, manifest) {
	const ownerId = resolveManifestOwner(manifest, ownerEntityHash)
	if (ownerId) {
		const handler = aclHandlers.get(ownerId)
		if (handler) return handler({ replicaUsername, ownerEntityHash, manifest })
		return false
	}
	return !isLogicalEntityHash(ownerEntityHash)
}

/**
 * 本地写授权：仅认 matcher 结果（写路径无 manifest，只按 ownerEntityHash 判定）。
 * @param {string} replicaUsername 请求 replica
 * @param {string} ownerEntityHash 所有者
 * @param {string} logicalPath 路径
 * @returns {Promise<boolean>} 是否允许写
 */
export async function canWriteManifestPath(replicaUsername, ownerEntityHash, logicalPath) {
	const ownerId = resolveManifestOwner(null, ownerEntityHash)
	if (ownerId) {
		const handler = aclHandlers.get(ownerId)
		if (handler) return handler({ replicaUsername, ownerEntityHash, manifest: {} }, logicalPath)
		return false
	}
	return !isLogicalEntityHash(ownerEntityHash) && isWritableLocalEntity(ownerEntityHash)
}
