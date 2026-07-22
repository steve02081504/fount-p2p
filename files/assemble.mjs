import { Buffer } from 'node:buffer'
import { createHash, randomBytes } from 'node:crypto'
import { setImmediate } from 'node:timers'

import { FEDERATION_CHUNK_MAX_BYTES } from '../core/constants.mjs'
import {
	encryptConvergentPlaintext,
	encryptRandomPlaintext,
	encryptRandomPlaintextWithKey,
	wrapContentKey,
} from '../crypto/key.mjs'

import { normalizeFileManifest, publicTransferKeyDescriptor } from './manifest.mjs'

/** @type {Record<string, (plain: Buffer) => { contentHash: string, ciphertextHash: string, raw: Buffer, contentKey?: Buffer }>} */
const ENCRYPTION_STRATEGIES = {
	/**
	 * @param {Buffer} plain 明文
	 * @returns {{ contentHash: string, ciphertextHash: string, raw: Buffer }} 分块结果
	 */
	plain: (plain) => {
		const contentHash = createHash('sha256').update(plain).digest('hex')
		return { contentHash, ciphertextHash: contentHash, raw: plain }
	},
	/**
	 * @param {Buffer} plain 明文
	 * @returns {{ contentHash: string, ciphertextHash: string, raw: Buffer }} 分块结果
	 */
	convergent: (plain) => encryptConvergentPlaintext(plain),
	/**
	 * @param {Buffer} plain 明文
	 * @returns {{ contentHash: string, ciphertextHash: string, raw: Buffer, contentKey: Buffer }} 分块结果
	 */
	random: (plain) => encryptRandomPlaintext(plain),
}

/**
 * @typedef {import('./manifest.mjs').FileManifest} FileManifest
 * @typedef {import('./manifest.mjs').CeMode} CeMode
 */

/**
 * @param {CeMode} ceMode 模式
 * @returns {(plain: Buffer) => { contentHash: string, ciphertextHash: string, raw: Buffer, contentKey?: Buffer }} 加密策略
 */
function encryptionStrategyFor(ceMode) {
	const strategy = ENCRYPTION_STRATEGIES[ceMode]
	if (!strategy) throw new Error(`unknown ceMode: ${ceMode}`)
	return strategy
}

/**
 * @param {{ contentHash: string, ciphertextHash: string, raw: Buffer }} enc 分块加密结果
 * @param {CeMode} ceMode 模式
 * @returns {{ hash: string, size: number, raw: Buffer, contentHash?: string }} manifest part
 */
function partFromEnc(enc, ceMode) {
	/** @type {{ hash: string, size: number, raw: Buffer, contentHash?: string }} */
	const part = { hash: enc.ciphertextHash, size: enc.raw.length, raw: enc.raw }
	if (ceMode === 'convergent' || ceMode === 'plain')
		part.contentHash = enc.contentHash
	return part
}

/**
 * 加密单个分块（random 模式复用调用方提供的 contentKey）。
 * @param {Buffer | Uint8Array} slice 明文分块
 * @param {CeMode} ceMode 模式
 * @param {Buffer | null} [contentKey] random 模式密钥
 * @returns {{ hash: string, size: number, raw: Buffer, contentHash?: string }} manifest part
 */
export function encryptSliceToPart(slice, ceMode, contentKey = null) {
	const enc = ceMode === 'random'
		? encryptRandomPlaintextWithKey(slice, contentKey)
		: encryptionStrategyFor(ceMode)(slice)
	return partFromEnc(enc, ceMode)
}

/**
 * @param {Array<{ hash: string, size: number, contentHash?: string }>} parts 分块
 * @returns {Array<{ hash: string, size: number, contentHash?: string }>} 写入 manifest 的 parts
 */
export function manifestPartsForPersist(parts) {
	return parts.map(part => {
		/** @type {{ hash: string, size: number, contentHash?: string }} */
		const out = { hash: part.hash, size: part.size }
		if (part.contentHash) out.contentHash = part.contentHash
		return out
	})
}

/**
 * @param {Buffer | Uint8Array} plaintext 明文
 * @param {CeMode} ceMode 模式
 * @returns {{ contentHash: string, parts: Array<{ hash: string, size: number, raw: Buffer, contentHash?: string }>, contentKey?: Buffer }} 加密结果
 */
export function encryptPlaintextToParts(plaintext, ceMode = 'convergent') {
	const plain = Buffer.from(plaintext)
	const enc = encryptionStrategyFor(ceMode)(plain)
	return {
		contentHash: enc.contentHash,
		parts: [partFromEnc(enc, ceMode)],
		contentKey: enc.contentKey,
	}
}

/**
 * 将明文拆分为多块加密（大文件）。
 * @param {Buffer | Uint8Array} plaintext 明文
 * @param {CeMode} ceMode 模式
 * @returns {{ contentHash: string, parts: Array<{ hash: string, size: number, raw: Buffer, contentHash?: string }>, contentKey?: Buffer }} 分块加密结果
 */
export function encryptPlaintextToMultiParts(plaintext, ceMode = 'convergent') {
	const plain = Buffer.from(plaintext)
	const contentHash = createHash('sha256').update(plain).digest('hex')
	if (plain.length <= FEDERATION_CHUNK_MAX_BYTES)
		return encryptPlaintextToParts(plain, ceMode)

	/** @type {Array<{ hash: string, size: number, raw: Buffer, contentHash?: string }>} */
	const parts = []
	const contentKey = ceMode === 'random' ? randomBytes(32) : null
	for (let offset = 0; offset < plain.length; offset += FEDERATION_CHUNK_MAX_BYTES)
		parts.push(encryptSliceToPart(plain.subarray(offset, offset + FEDERATION_CHUNK_MAX_BYTES), ceMode, contentKey))
	return { contentHash, parts, contentKey: contentKey || undefined }
}

/**
 * 异步多块加密，周期性让出事件循环。
 * @param {Buffer | Uint8Array} plaintext 明文
 * @param {CeMode} ceMode 模式
 * @returns {Promise<{ contentHash: string, parts: Array<{ hash: string, size: number, raw: Buffer }>, contentKey?: Buffer }>} 分块加密结果
 */
export async function encryptPlaintextToMultiPartsAsync(plaintext, ceMode = 'convergent') {
	const plain = Buffer.from(plaintext)
	const contentHash = createHash('sha256').update(plain).digest('hex')
	if (plain.length <= FEDERATION_CHUNK_MAX_BYTES)
		return encryptPlaintextToParts(plain, ceMode)

	/** @type {Array<{ hash: string, size: number, raw: Buffer, contentHash?: string }>} */
	const parts = []
	const contentKey = ceMode === 'random' ? randomBytes(32) : null
	for (let offset = 0; offset < plain.length; offset += FEDERATION_CHUNK_MAX_BYTES) {
		if (offset > 0) await new Promise(resolve => setImmediate(resolve))
		parts.push(encryptSliceToPart(plain.subarray(offset, offset + FEDERATION_CHUNK_MAX_BYTES), ceMode, contentKey))
	}
	return { contentHash, parts, contentKey: contentKey || undefined }
}

/**
 * @param {object} parameters 参数
 * @param {string} parameters.ownerEntityHash 128 hex
 * @param {string} parameters.logicalPath EVFS 路径
 * @param {Buffer | Uint8Array} parameters.plaintext 明文
 * @param {string} [parameters.name] 文件名
 * @param {string} [parameters.mimeType] MIME
 * @param {CeMode} [parameters.ceMode] 加密模式
 * @param {import('./manifest.mjs').TransferKeyDescriptor} [parameters.transferKeyDescriptor] 传递密钥
 * @param {object} [parameters.meta] 元数据
 * @returns {FileManifest} manifest（未写盘）
 */
export function buildFileManifest(parameters) {
	const {
		ownerEntityHash,
		logicalPath,
		plaintext,
		name,
		mimeType = 'application/octet-stream',
		ceMode = 'convergent',
		transferKeyDescriptor,
		meta,
	} = parameters
	const enc = encryptPlaintextToParts(plaintext, ceMode)
	const manifest = normalizeFileManifest({
		ownerEntityHash: ownerEntityHash.toLowerCase(),
		logicalPath: logicalPath.replace(/^\/+/, ''),
		name: name || logicalPath.split('/').pop() || 'file',
		mimeType,
		size: Buffer.from(plaintext).length,
		contentHash: enc.contentHash,
		ceMode,
		parts: manifestPartsForPersist(enc.parts),
		transferKeyDescriptor: transferKeyDescriptor || publicTransferKeyDescriptor(),
		meta,
	})
	if (!manifest) throw new Error('invalid manifest')
	return manifest
}

/**
 * 由已加密分块构建 manifest（vault / file-master-key-wrap 等需自定义 transferKeyDescriptor）。
 * @param {object} parameters 与 buildFileManifest 相同字段（不含 plaintext 重加密）
 * @param {{ contentHash: string, parts: Array<{ hash: string, size: number, raw?: Buffer, contentHash?: string }> }} enc 加密结果
 * @returns {FileManifest} manifest
 */
export function buildFileManifestFromEnc(parameters, enc) {
	const {
		ownerEntityHash,
		logicalPath,
		plaintext,
		name,
		mimeType = 'application/octet-stream',
		ceMode = 'convergent',
		transferKeyDescriptor,
		meta,
	} = parameters
	const manifest = normalizeFileManifest({
		ownerEntityHash: ownerEntityHash.toLowerCase(),
		logicalPath: logicalPath.replace(/^\/+/, ''),
		name: name || logicalPath.split('/').pop() || 'file',
		mimeType,
		size: Buffer.from(plaintext).length,
		contentHash: enc.contentHash,
		ceMode,
		parts: manifestPartsForPersist(enc.parts),
		transferKeyDescriptor: transferKeyDescriptor || publicTransferKeyDescriptor(),
		meta,
	})
	if (!manifest) throw new Error('invalid manifest')
	return manifest
}

/**
 * @param {string} entityHash 所有者
 * @param {string} fileId 文件 ID
 * @param {Buffer} contentKey 随机密钥
 * @param {Buffer | string} H vault H
 * @returns {import('./manifest.mjs').TransferKeyDescriptor} 传输密钥描述
 */
export function vaultWrapDescriptor(entityHash, fileId, contentKey, H) {
	return {
		type: 'vault-wrap',
		entityHash: entityHash.toLowerCase(),
		fileId,
		wrappedKey: wrapContentKey(contentKey, H, fileId),
	}
}
