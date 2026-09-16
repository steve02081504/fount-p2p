import { resolveManifestOwner } from './manifest/routing.mjs'

/** @type {Map<string, { getGroupFileMasterKey?: (replicaUsername: string, groupId: string, keyGeneration?: number) => Promise<Buffer | string | null>, getVaultMasterKey?: (replicaUsername: string, entityHash: string) => Promise<Buffer | string | null> }>} */
const transferDependenciesByOwner = new Map()

/** @type {Map<string, (replicaUsername: string, manifest: import('./manifest/normalize.mjs').FileManifest) => Promise<Buffer | null>>} */
const dagPlaintextReadersByOwner = new Map()

/**
 * @param {string} ownerId 注册方（族，须与 registerManifestOwner 一致）
 * @param {{ getGroupFileMasterKey?: (replicaUsername: string, groupId: string, keyGeneration?: number) => Promise<Buffer | string | null>, getVaultMasterKey?: (replicaUsername: string, entityHash: string) => Promise<Buffer | string | null> }} dependencies 密钥源
 * @returns {void}
 */
export function registerTransferKeyDependencies(ownerId, dependencies) {
	const prev = transferDependenciesByOwner.get(ownerId) || {}
	transferDependenciesByOwner.set(ownerId, { ...prev, ...dependencies })
}

/**
 * @param {string} ownerId 注册方
 * @param {(replicaUsername: string, manifest: import('./manifest/normalize.mjs').FileManifest) => Promise<Buffer | null>} reader dagParts 明文读取
 * @returns {void}
 */
export function registerDagManifestPlaintextReader(ownerId, reader) {
	dagPlaintextReadersByOwner.set(ownerId, reader)
}

/**
 * @param {string} ownerId 注册方
 * @returns {void}
 */
export function unregisterTransferKeyDependencies(ownerId) {
	transferDependenciesByOwner.delete(ownerId)
	dagPlaintextReadersByOwner.delete(ownerId)
}

/**
 * @param {string} [ownerId] 显式注册方；省略时按 manifest 推断
 * @param {import('./manifest/normalize.mjs').FileManifest} [manifest] 用于推断 ownerId
 * @returns {{ getGroupFileMasterKey?: (replicaUsername: string, groupId: string, keyGeneration?: number) => Promise<Buffer | string | null>, getVaultMasterKey?: (replicaUsername: string, entityHash: string) => Promise<Buffer | string | null> }} 依赖
 */
export function resolveTransferKeyDependencies(ownerId, manifest) {
	const resolved = ownerId || (manifest ? resolveManifestOwner(manifest, manifest.ownerEntityHash) : null)
	if (resolved) return transferDependenciesByOwner.get(resolved) || {}
	return {}
}

/**
 * @param {string} replicaUsername 副本用户名
 * @param {import('./manifest/normalize.mjs').FileManifest} manifest 清单
 * @returns {Promise<Buffer | null>} 明文；无 reader 或未命中为 null
 */
export async function readDagManifestPlaintext(replicaUsername, manifest) {
	const ownerId = resolveManifestOwner(manifest, manifest.ownerEntityHash)
	if (ownerId) {
		const reader = dagPlaintextReadersByOwner.get(ownerId)
		if (reader)
			try {
				const buffer = await reader(replicaUsername, manifest)
				if (buffer?.length) return buffer
			}
			catch { /* 读取失败则回落到分块路径 */ }
	}
	return null
}
