import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'

import { FEDERATION_CHUNK_MAX_BYTES } from '../core/constants.mjs'
import { getEntityStore } from '../node/instance.mjs'

import { buildFileManifestFromEnc, encryptPlaintextToMultiPartsAsync, encryptPlaintextToParts, manifestPartsForPersist } from './assemble.mjs'
import { createManifestPlaintextStream, encryptReadableToParts } from './assemble_stream.mjs'
import { fetchChunk } from './chunk/fetch.mjs'
import { createChunkReadStream, getChunk, hasChunk, putChunk } from './chunk/store.mjs'
import { normalizeFileManifest, publicTransferKeyDescriptor } from './manifest/normalize.mjs'
import { assembleManifestPlaintext, resolveContentKey } from './transfer_key.mjs'
import { readDagManifestPlaintext, resolveTransferKeyDependencies } from './transfer_key_registry.mjs'

/**
 * @param {string} replicaUsername 副本用户名
 * @param {import('./manifest/normalize.mjs').FileManifest} manifest 清单
 * @returns {{ getGroupFileMasterKey?: Function, getVaultMasterKey?: Function }} 密钥依赖
 */
function transferKeyDependenciesForReplica(replicaUsername, manifest) {
	const rawDependencies = resolveTransferKeyDependencies(undefined, manifest)
	return {
		getGroupFileMasterKey: rawDependencies.getGroupFileMasterKey
			? (groupId, keyGeneration) => rawDependencies.getGroupFileMasterKey(replicaUsername, groupId, keyGeneration)
			: undefined,
		getVaultMasterKey: rawDependencies.getVaultMasterKey
			? entityHash => rawDependencies.getVaultMasterKey(replicaUsername, entityHash)
			: undefined,
	}
}

/**
 * @param {string} username 拉取身份
 * @param {import('./manifest/normalize.mjs').FileManifest} manifest 清单
 * @param {{ fetchChunk?: Function, fanoutTargets?: string[] }} [options] miss 拉取
 * @returns {Promise<boolean>} 全部 part 是否已就位
 */
async function ensureManifestPartsLocal(username, manifest, options = {}) {
	for (const part of manifest.parts) {
		if (await hasChunk(part.hash)) continue
		const fetchedChunk = await (options.fetchChunk || fetchChunk)({
			username,
			ciphertextHash: part.hash,
			ownerEntityHash: manifest.ownerEntityHash,
			groupId: manifest.transferKeyDescriptor.groupId,
			fanoutTargets: options.fanoutTargets,
		})
		if (!fetchedChunk) return false
		await putChunk(part.hash, fetchedChunk)
	}
	return true
}

/**
 * @param {string} ownerEntityHash 所有者
 * @param {string} logicalPath 路径
 * @returns {Promise<import('./manifest/normalize.mjs').FileManifest | null>} 本机已写盘的 manifest
 */
export async function loadFileManifest(ownerEntityHash, logicalPath) {
	return getEntityStore().readManifest(ownerEntityHash, logicalPath)
}

/**
 * @param {import('./manifest/normalize.mjs').FileManifest} manifest 清单
 * @returns {Promise<void>}
 */
export async function saveFileManifest(manifest) {
	await getEntityStore().writeManifest(manifest.ownerEntityHash, manifest.logicalPath, manifest)
}

/**
 * 删除本机已写盘 manifest；其引用的 chunk 孤儿化后由 `cleanChunkGarbage` 回收。
 * @param {string} ownerEntityHash 所有者
 * @param {string} logicalPath 路径
 * @returns {Promise<void>} 删除成功或不存在
 */
export async function deleteFileManifest(ownerEntityHash, logicalPath) {
	const entityStore = getEntityStore()
	if (entityStore.deleteManifest)
		await entityStore.deleteManifest(ownerEntityHash, logicalPath)
	else
		throw new Error('entityStore lacks deleteManifest')
}

/**
 * @param {import('./manifest/normalize.mjs').FileManifest} manifest 清单
 * @param {Array<Buffer | Uint8Array>} partBytes 密文块
 * @returns {Promise<void>}
 */
export async function storeManifestParts(manifest, partBytes) {
	for (let index = 0; index < manifest.parts.length; index++)
		await putChunk(manifest.parts[index].hash, partBytes[index])
}

/**
 * @param {string} replicaUsername 副本用户名
 * @param {import('./manifest/normalize.mjs').FileManifest} manifest 清单
 * @param {{ username?: string, fetchChunk?: Function, fanoutTargets?: string[] }} [options] miss 拉取
 * @returns {Promise<Buffer | null>} 明文内容
 */
export async function readManifestPlaintext(replicaUsername, manifest, options = {}) {
	const dagGroupId = manifest.meta?.groupId
	if (manifest.meta?.dagParts?.length && dagGroupId) {
		const dagPlain = await readDagManifestPlaintext(replicaUsername, manifest)
		if (dagPlain) return dagPlain
	}

	const username = options.username || replicaUsername
	if (!await ensureManifestPartsLocal(username, manifest, options)) return null

	/** @type {Buffer[]} */
	const partBytes = []
	for (const part of manifest.parts)
		partBytes.push(await getChunk(part.hash))

	return assembleManifestPlaintext(manifest, partBytes, transferKeyDependenciesForReplica(replicaUsername, manifest))
}

/**
 * @param {string} replicaUsername 副本用户名
 * @param {import('./manifest/normalize.mjs').FileManifest} manifest 清单
 * @param {{ username?: string, fetchChunk?: Function, fanoutTargets?: string[] }} [options] miss 拉取
 * @returns {Promise<import('node:stream').Readable | null>} 明文流
 */
export async function readManifestPlaintextStream(replicaUsername, manifest, options = {}) {
	const dagGroupId = manifest.meta?.groupId
	if (manifest.meta?.dagParts?.length && dagGroupId) {
		const plain = await readManifestPlaintext(replicaUsername, manifest, options)
		if (!plain) return null
		return Readable.from([plain])
	}

	const username = options.username || replicaUsername
	if (!await ensureManifestPartsLocal(username, manifest, options)) return null

	const dependencies = transferKeyDependenciesForReplica(replicaUsername, manifest)
	const contentKey = await resolveContentKey(manifest.transferKeyDescriptor, manifest, dependencies)
	if (manifest.ceMode === 'random' && !contentKey) return null

	const partStreams = manifest.parts.map(part => createChunkReadStream(part.hash))
	return createManifestPlaintextStream(manifest, partStreams, contentKey)
}

/**
 * @param {object} parameters 参数
 * @param {string} parameters.ownerEntityHash owner
 * @param {string} parameters.logicalPath 路径
 * @param {Buffer | Uint8Array} parameters.plaintext 明文
 * @param {string} [parameters.name] 文件名
 * @param {string} [parameters.mimeType] MIME
 * @param {import('./manifest/normalize.mjs').CeMode} [parameters.ceMode] 模式
 * @param {import('./manifest/normalize.mjs').TransferKeyDescriptor} [parameters.transferKeyDescriptor] 传递密钥
 * @param {object} [parameters.meta] meta
 * @returns {Promise<import('./manifest/normalize.mjs').FileManifest>} 写入后的 manifest
 */
export async function putFileManifest(parameters) {
	const {
		ownerEntityHash,
		logicalPath,
		plaintext,
		name,
		mimeType,
		ceMode = 'convergent',
		transferKeyDescriptor,
		meta,
	} = parameters
	const plaintextBuffer = Buffer.from(plaintext)
	const enc = plaintextBuffer.length > FEDERATION_CHUNK_MAX_BYTES
		? await encryptPlaintextToMultiPartsAsync(plaintextBuffer, ceMode)
		: encryptPlaintextToParts(plaintextBuffer, ceMode)
	const manifest = buildFileManifestFromEnc({
		ownerEntityHash,
		logicalPath,
		plaintext: plaintextBuffer,
		name,
		mimeType,
		ceMode,
		transferKeyDescriptor: transferKeyDescriptor || publicTransferKeyDescriptor(),
		meta,
	}, enc)
	await storeManifestParts(manifest, enc.parts.map(part => part.raw))
	await saveFileManifest(manifest)
	return manifest
}

/**
 * 流式写入文件（请求流 -> 加密分块 -> chunk store）。
 * @param {object} parameters 参数
 * @param {string} parameters.ownerEntityHash owner
 * @param {string} parameters.logicalPath 路径
 * @param {import('node:stream').Readable} parameters.readable 明文流
 * @param {number} parameters.plainSize 明文字节数
 * @param {string} [parameters.name] 文件名
 * @param {string} [parameters.mimeType] MIME
 * @param {import('./manifest/normalize.mjs').CeMode} [parameters.ceMode] 模式
 * @param {import('./manifest/normalize.mjs').TransferKeyDescriptor} [parameters.transferKeyDescriptor] 传递密钥
 * @param {object} [parameters.meta] meta
 * @returns {Promise<import('./manifest/normalize.mjs').FileManifest>} 写入后的 manifest
 */
export async function putFileManifestFromStream(parameters) {
	const {
		ownerEntityHash,
		logicalPath,
		readable,
		plainSize,
		name,
		mimeType,
		ceMode = 'convergent',
		transferKeyDescriptor,
		meta,
	} = parameters
	const enc = await encryptReadableToParts(readable, ceMode, async part =>
		putChunk(part.hash, part.raw), plainSize)
	const manifest = normalizeFileManifest({
		ownerEntityHash,
		logicalPath: logicalPath.replace(/^\/+/, ''),
		name: name || logicalPath.split('/').pop() || 'file',
		mimeType: mimeType || 'application/octet-stream',
		size: plainSize,
		contentHash: enc.contentHash,
		ceMode,
		parts: manifestPartsForPersist(enc.parts),
		transferKeyDescriptor: transferKeyDescriptor || publicTransferKeyDescriptor(),
		meta,
	})
	if (!manifest) throw new Error('invalid manifest')
	await saveFileManifest(manifest)
	return manifest
}

/**
 * 读取实体公开文件：本地 miss 时经网络取回签名 manifest，chunk miss 走既有 fetchChunk。
 * 传入 `fanoutTargets` 时 manifest 与 chunk 拉取均定向到目标集（public 文件跨节点直取 owner 节点，避免 node-scope 大扇出）。
 * @param {string} replicaUsername 副本用户名
 * @param {string} entityHash owner entityHash
 * @param {string} logicalPath EVFS 逻辑路径
 * @param {{ username?: string, fetchChunk?: Function, revalidate?: boolean, fanoutTargets?: string[] }} [options] miss 拉取；`revalidate` 强制阻塞等待 fanout 择新
 * @returns {Promise<Buffer | null>} 明文或 null
 */
export async function readPublicFile(replicaUsername, entityHash, logicalPath, options = {}) {
	const { fetchManifest } = await import('./manifest/fetch.mjs')
	const manifest = await fetchManifest({
		username: options.username || replicaUsername,
		ownerEntityHash: entityHash,
		logicalPath,
		cache: true,
		revalidate: options.revalidate === true,
		fanoutTargets: options.fanoutTargets,
	})
	if (!manifest) return null
	return readManifestPlaintext(replicaUsername, manifest, options)
}
