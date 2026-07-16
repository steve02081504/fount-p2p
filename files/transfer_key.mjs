import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

import {
	decryptConvergentCiphertext,
	decryptRandomCiphertext,
	unwrapContentKey,
} from '../crypto/key.mjs'

/**
 * @typedef {import('./manifest.mjs').FileManifest} FileManifest
 * @typedef {import('./manifest.mjs').TransferKeyDescriptor} TransferKeyDescriptor
 */

/**
 * @param {TransferKeyDescriptor} descriptor 传递密钥描述符
 * @param {FileManifest} manifest manifest
 * @param {{ getGroupFileMasterKey?: (groupId: string, keyGeneration?: number) => Promise<Buffer | string | null>, getVaultMasterKey?: (entityHash: string) => Promise<Buffer | string | null> }} dependencies 密钥源
 * @returns {Promise<Buffer | null>} contentKey；plain/convergent 返回 null（按 contentHash 派生）
 */
export async function resolveContentKey(descriptor, manifest, dependencies = {}) {
	const type = descriptor?.type || 'public'
	if (type === 'public' || manifest.ceMode === 'plain' || manifest.ceMode === 'convergent')
		return null

	if (type === 'file-master-key-wrap') {
		const { groupId, fileId } = descriptor
		if (!groupId || !fileId || !descriptor.wrappedKey || !dependencies.getGroupFileMasterKey) return null
		const groupKey = await dependencies.getGroupFileMasterKey(String(groupId), descriptor.keyGeneration)
		if (!groupKey) return null
		return unwrapContentKey(descriptor.wrappedKey, groupKey, fileId)
	}

	if (type === 'vault-wrap') {
		const { entityHash, fileId } = descriptor
		if (!entityHash || !fileId || !descriptor.wrappedKey || !dependencies.getVaultMasterKey) return null
		const vaultKey = await dependencies.getVaultMasterKey(String(entityHash))
		if (!vaultKey) return null
		return unwrapContentKey(descriptor.wrappedKey, vaultKey, fileId)
	}

	return null
}

/**
 * @param {Buffer | Uint8Array} encryptedPartBytes 密文块
 * @param {FileManifest} manifest manifest
 * @param {Buffer | null} contentKey random 模式密钥
 * @param {number} [partIndex] 分块下标（多块 convergent 用 part.contentHash）
 * @returns {Buffer | null} 明文
 */
export function decryptPart(encryptedPartBytes, manifest, contentKey, partIndex = 0) {
	if (manifest.ceMode === 'plain')
		return Buffer.from(encryptedPartBytes)

	if (manifest.ceMode === 'convergent') {
		const partPlainHash = manifest.parts[partIndex]?.contentHash || manifest.contentHash
		return decryptConvergentCiphertext(encryptedPartBytes, partPlainHash)
	}

	if (manifest.ceMode === 'random' && contentKey) {
		// 多块时各块明文 hash ≠ 整文件 contentHash；完整性在 assemble 末尾校验
		const verifyHash = manifest.parts.length === 1 ? manifest.contentHash : ''
		return decryptRandomCiphertext(encryptedPartBytes, contentKey, verifyHash)
	}

	return null
}

/**
 * @param {FileManifest} manifest manifest
 * @param {Array<Buffer | Uint8Array>} partBytes 按序密文块
 * @param {{ getGroupFileMasterKey?: Function, getVaultMasterKey?: Function }} dependencies 密钥源
 * @returns {Promise<Buffer | null>} 完整明文
 */
export async function assembleManifestPlaintext(manifest, partBytes, dependencies = {}) {
	if (partBytes.length !== manifest.parts.length) return null
	const contentKey = await resolveContentKey(manifest.transferKeyDescriptor, manifest, dependencies)
	/** @type {Buffer[]} */
	const plains = []
	for (let index = 0; index < manifest.parts.length; index++) {
		const plain = decryptPart(partBytes[index], manifest, contentKey, index)
		if (!plain) return null
		plains.push(plain)
	}
	const merged = Buffer.concat(plains)
	if (manifest.contentHash)
		if (createHash('sha256').update(merged).digest('hex') !== manifest.contentHash.toLowerCase()) return null

	return merged
}
