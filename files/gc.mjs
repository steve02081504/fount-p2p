import fsp from 'node:fs/promises'
import { join } from 'node:path'

import { isHex64 } from '../core/hexIds.mjs'
import { getEntityStore, getNodeLogger } from '../node/instance.mjs'

import {
	chunkStoreRoot,
	unlinkChunkFile,
	withChunkStoreLock,
} from './chunk/store.mjs'
import { normalizeFileManifest } from './manifest/normalize.mjs'

/**
 * @typedef {{ hash: string, size: number }} GcChunkTarget
 */

/**
 * @typedef {{
 *   manifests: number,
 *   brokenManifests: Array<{ ownerEntityHash: string, logicalPath: string }>,
 *   referenced: number,
 *   candidates: Array<GcChunkTarget>,
 *   deleted: number,
 *   retained: number,
 *   freedBytes: number,
 *   brokenDeleted: number,
 * }} GarbageCollectionReport
 */

/**
 * 纯读扫描：以全部写盘 manifest 的 `parts[].hash` 为根集，枚举 `chunks/` 孤儿块与坏 manifest。
 * 无副作用（不删文件）。
 * @returns {Promise<GarbageCollectionReport>} 扫描报告
 */
async function scanChunkGarbage() {
	const entityStore = getEntityStore()
	const referenced = new Set()
	const brokenManifests = []
	let manifests = 0

	const entityHashes = await entityStore.listEntityHashes()
	for (const entityHash of entityHashes) {
		const logicalPaths = await entityStore.listEntityFiles(entityHash)
		for (const logicalPath of logicalPaths) {
			manifests++
			const raw = await entityStore.readManifest(entityHash, logicalPath)
			const normalized = normalizeFileManifest(raw)
			if (!normalized) {
				brokenManifests.push({ ownerEntityHash: entityHash, logicalPath })
				continue
			}
			for (const part of normalized.parts)
				referenced.add(part.hash)
		}
	}

	/** @type {GcChunkTarget[]} */
	const candidates = []
	let freedBytes = 0
	let prefixEntries
	try {
		prefixEntries = await fsp.readdir(chunkStoreRoot(), { withFileTypes: true })
	}
	catch {
		prefixEntries = []
	}
	for (const prefixEntry of prefixEntries) {
		if (!prefixEntry.isDirectory() || prefixEntry.name.length !== 2) continue
		let files
		try {
			files = await fsp.readdir(join(chunkStoreRoot(), prefixEntry.name))
		}
		catch { continue }
		for (const name of files) {
			if (!name.endsWith('.bin')) continue
			const hash = name.slice(0, -4)
			if (!isHex64(hash) || referenced.has(hash)) continue
			const size = await chunkFileSize(join(chunkStoreRoot(), prefixEntry.name, name))
			candidates.push({ hash, size })
			freedBytes += size
		}
	}

	return {
		manifests,
		brokenManifests,
		referenced: referenced.size,
		candidates,
		deleted: 0,
		retained: 0,
		freedBytes,
		brokenDeleted: 0,
	}
}

/**
 * @param {string} filePath chunk 文件绝对路径
 * @returns {Promise<number>} 文件字节数；stat 失败为 0
 */
async function chunkFileSize(filePath) {
	try {
		const { size } = await fsp.stat(filePath)
		return size
	}
	catch { return 0 }
}

/**
 * 持锁删除一批 chunk，统计删除结果并顺带清理已空前缀目录。
 * @param {string[]} hashes 待删 64 位 hex 集合
 * @returns {Promise<{ deleted: number, retained: number, freedBytes: number }>} 删除结果统计
 */
async function removeChunkHashes(hashes) {
	let deleted = 0
	let retained = 0
	let freedBytes = 0
	const emptiedPrefixes = new Set()
	await withChunkStoreLock(async () => {
		for (const hash of hashes) {
			const result = await unlinkChunkFile(hash)
			if (result.deleted) {
				deleted++
				freedBytes += result.size
				emptiedPrefixes.add(hash.slice(0, 2))
			}
			else retained++
		}
		for (const prefix of emptiedPrefixes) try {
			await fsp.rmdir(join(chunkStoreRoot(), prefix))
		} catch { /* 目录非空或已被删，忽略 */ }
	})
	return { deleted, retained, freedBytes }
}

/**
 * 扫描并报告 chunk 垃圾（只读，不删除）。
 * 根集 = 全部写盘 manifest 的 `parts[].hash`（含公共/非 public 缓存）；`chunks/` 中不在根集的可回收。
 * @returns {Promise<GarbageCollectionReport>} 统计报告
 */
export async function mapChunkGarbage() {
	return scanChunkGarbage()
}

/**
 * 清理 chunk 垃圾。缺省 `targets` 时先扫描再删除（并自动清除扫描到的坏 manifest）；
 * 提供 `targets` 时只按给定集合删除，不做扫描、不碰 manifest。
 * @param {{ targets?: Array<string | GcChunkTarget> }} [options] 可选显式目标集
 * @returns {Promise<GarbageCollectionReport>} 执行报告
 */
export async function cleanChunkGarbage(options = {}) {
	const targets = Array.isArray(options.targets)

	/** @type {string[]} */
	let hashes
	if (targets) {
		hashes = options.targets.map(target => {
			const hash = typeof target === 'string' ? target : target?.hash
			if (!isHex64(hash)) throw new Error(`cleanChunkGarbage: invalid chunk hash ${hash}`)
			return hash
		})
		const { deleted, retained, freedBytes } = await removeChunkHashes(hashes)
		return {
			manifests: 0,
			brokenManifests: [],
			referenced: 0,
			candidates: hashes.map(hash => ({ hash, size: 0 })),
			deleted,
			retained,
			freedBytes,
			brokenDeleted: 0,
		}
	}

	const snapshot = await scanChunkGarbage()
	const entityStore = getEntityStore()
	const logger = getNodeLogger()
	let brokenDeleted = 0
	if (snapshot.brokenManifests.length) {
		for (const broken of snapshot.brokenManifests) {
			if (!entityStore.deleteManifest) break
			await entityStore.deleteManifest(broken.ownerEntityHash, broken.logicalPath)
			brokenDeleted++
		}
		logger?.info?.(`chunk GC: removed ${brokenDeleted} broken manifest(s)`)
	}

	const { deleted, retained, freedBytes } = await removeChunkHashes(
		snapshot.candidates.map(candidate => candidate.hash),
	)
	return { ...snapshot, deleted, retained, freedBytes, brokenDeleted }
}
