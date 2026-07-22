import { Buffer } from 'node:buffer'

import { canonicalStringify } from '../core/canonical_json.mjs'
import { hashFromPubKeyHex, parseEntityHash } from '../core/entity_id.mjs'
import { assertSafeEvfsLogicalPath } from '../core/evfs_logical_path.mjs'
import { isHex64, normalizeHex64 } from '../core/hexIds.mjs'
import { sign, verify } from '../crypto/crypto.mjs'

import { putFileManifest, saveFileManifest } from './evfs.mjs'
import { normalizeFileManifest, publicTransferKeyDescriptor } from './manifest.mjs'

/** 实体公开 manifest 签名域 */
export const ENTITY_PUBLIC_MANIFEST_DOMAIN = 'fount-entity-public-manifest'

/**
 * @param {object} fields 待签名字段
 * @returns {Buffer} 签名消息字节
 */
export function publicManifestSignBytes(fields) {
	return Buffer.from(canonicalStringify([
		ENTITY_PUBLIC_MANIFEST_DOMAIN,
		String(fields.ownerEntityHash || '').trim().toLowerCase(),
		assertSafeEvfsLogicalPath(fields.logicalPath),
		Number(fields.publishedAt) || 0,
		String(fields.contentHash || '').trim().toLowerCase(),
		Number(fields.size) || 0,
		String(fields.mimeType || ''),
		String(fields.name || ''),
		String(fields.ceMode || ''),
		fields.parts || [],
	]), 'utf8')
}

/**
 * @param {import('./manifest.mjs').FileManifest} manifest 清单
 * @param {number} publishedAt 发布时间
 * @param {Uint8Array | Buffer} entitySecretKey recovery 私钥种子
 * @param {string} entityPubKeyHex recovery 公钥 hex
 * @returns {Promise<import('./manifest.mjs').FileManifest>} 带 publicSig 的清单
 */
export async function attachPublicManifestSig(manifest, publishedAt, entitySecretKey, entityPubKeyHex) {
	const pubKeyHex = normalizeHex64(entityPubKeyHex)
	const message = publicManifestSignBytes({
		ownerEntityHash: manifest.ownerEntityHash,
		logicalPath: manifest.logicalPath,
		publishedAt,
		contentHash: manifest.contentHash,
		size: manifest.size,
		mimeType: manifest.mimeType,
		name: manifest.name,
		ceMode: manifest.ceMode,
		parts: manifest.parts,
	})
	const sigHex = Buffer.from(await sign(message, entitySecretKey)).toString('hex')
	return {
		...manifest,
		meta: {
			...manifest.meta || {},
			publicSig: { publishedAt, pubKeyHex, sigHex },
		},
	}
}

/**
 * @param {unknown} input 原始 manifest
 * @returns {Promise<import('./manifest.mjs').FileManifest | null>} 验签通过的清单；非法为 null
 */
export async function verifySignedPublicManifest(input) {
	const manifest = normalizeFileManifest(input)
	if (!manifest) return null
	if (manifest.transferKeyDescriptor.type !== 'public') return null

	const publicSig = input?.meta?.publicSig
	if (!publicSig || typeof publicSig !== 'object') return null
	const publishedAt = Number(publicSig.publishedAt) || 0
	const pubKeyHex = normalizeHex64(publicSig.pubKeyHex)
	const sigHex = String(publicSig.sigHex || '').trim().toLowerCase()
	if (!isHex64(pubKeyHex) || !/^[\da-f]{128}$/u.test(sigHex) || publishedAt <= 0) return null

	const parsed = parseEntityHash(manifest.ownerEntityHash)
	if (!parsed) return null
	if (hashFromPubKeyHex(pubKeyHex) !== parsed.subjectHash) return null

	const message = publicManifestSignBytes({
		ownerEntityHash: manifest.ownerEntityHash,
		logicalPath: manifest.logicalPath,
		publishedAt,
		contentHash: manifest.contentHash,
		size: manifest.size,
		mimeType: manifest.mimeType,
		name: manifest.name,
		ceMode: manifest.ceMode,
		parts: manifest.parts,
	})
	const ok = await verify(Buffer.from(sigHex, 'hex'), message, Buffer.from(pubKeyHex, 'hex'))
	if (!ok) return null

	// 签名只覆盖内容字段：入站 meta 一律丢弃，仅保留 publicSig，
	// 防止中继注入 dagParts/groupId 等本地扩展改写读取路径。
	return {
		...manifest,
		meta: { publicSig: { publishedAt, pubKeyHex, sigHex } },
	}
}

/**
 * @param {object | null | undefined} localManifest 本地已有清单
 * @param {import('./manifest.mjs').FileManifest} incoming 入站已验签清单
 * @returns {boolean} 是否应以 incoming 覆盖本地缓存
 */
export function shouldPreferIncomingPublicManifest(localManifest, incoming) {
	const incomingAt = Number(incoming?.meta?.publicSig?.publishedAt) || 0
	if (incomingAt <= 0) return false
	const localAt = Number(localManifest?.meta?.publicSig?.publishedAt) || 0
	return incomingAt > localAt
}

/**
 * @param {object} parameters 参数
 * @param {string} parameters.ownerEntityHash owner
 * @param {string} parameters.logicalPath 路径
 * @param {Buffer | Uint8Array} parameters.plaintext 明文
 * @param {string} [parameters.name] 文件名
 * @param {string} [parameters.mimeType] MIME
 * @param {Uint8Array | Buffer} parameters.entitySecretKey recovery 私钥种子
 * @param {string} parameters.entityPubKeyHex recovery 公钥 hex
 * @param {number} [parameters.publishedAt] 发布时间（默认 Date.now）
 * @returns {Promise<import('./manifest.mjs').FileManifest>} 已签名并落盘的公开清单
 */
export async function publishPublicFile(parameters) {
	const {
		ownerEntityHash,
		logicalPath,
		plaintext,
		name,
		mimeType,
		entitySecretKey,
		entityPubKeyHex,
		publishedAt = Date.now(),
	} = parameters
	const base = await putFileManifest({
		ownerEntityHash,
		logicalPath,
		plaintext,
		name,
		mimeType,
		ceMode: 'convergent',
		transferKeyDescriptor: publicTransferKeyDescriptor(),
	})
	const signed = await attachPublicManifestSig(base, publishedAt, entitySecretKey, entityPubKeyHex)
	await saveFileManifest(signed)
	return signed
}
