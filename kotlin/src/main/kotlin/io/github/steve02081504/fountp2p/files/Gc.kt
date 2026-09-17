package io.github.steve02081504.fountp2p.files

import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.federation.jsString
import io.github.steve02081504.fountp2p.files.chunk.chunkStoreRoot
import io.github.steve02081504.fountp2p.files.chunk.unlinkChunkFile
import io.github.steve02081504.fountp2p.files.chunk.withChunkStoreLock
import io.github.steve02081504.fountp2p.files.manifest.normalizeFileManifest
import io.github.steve02081504.fountp2p.node.getEntityStore
import io.github.steve02081504.fountp2p.node.getNodeLogger
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.nio.file.Files
import java.nio.file.Paths

/**
 * chunk 垃圾回收（等价 `files/gc.mjs`）。
 */

/** 待回收 chunk。 */
data class GcChunkTarget(
	/** 64 位十六进制 hash */
	val hash: String,
	/** 文件字节数 */
	val size: Long,
)

/** 坏 manifest 引用。 */
data class BrokenManifestRef(
	/** owner */
	val ownerEntityHash: String,
	/** 逻辑路径 */
	val logicalPath: String,
)

/** 扫描/执行报告。 */
data class GarbageCollectionReport(
	/** manifest 总数 */
	val manifests: Long,
	/** 坏 manifest */
	val brokenManifests: List<BrokenManifestRef>,
	/** 被引用 chunk 数 */
	val referenced: Long,
	/** 可回收 chunk */
	val candidates: List<GcChunkTarget>,
	/** 已删除数 */
	val deleted: Long,
	/** 仍被占用数 */
	val retained: Long,
	/** 释放字节数 */
	val freedBytes: Long,
	/** 已删除坏 manifest 数 */
	val brokenDeleted: Long,
)

/** 删除结果统计。 */
private class RemoveResult(val deleted: Long, val retained: Long, val freedBytes: Long)

/**
 * 纯读扫描：以全部写盘 manifest 的 `parts[].hash` 为根集，枚举 `chunks/` 孤儿块与坏 manifest。
 * 无副作用（不删文件）。
 * @return 扫描报告
 */
private suspend fun scanChunkGarbage(): GarbageCollectionReport {
	val entityStore = getEntityStore()
	val referenced = LinkedHashSet<String>()
	val brokenManifests = ArrayList<BrokenManifestRef>()
	var manifests = 0L

	for (entityHash in entityStore.listEntityHashes()) {
		for (logicalPath in entityStore.listEntityFiles(entityHash)) {
			manifests++
			val raw = entityStore.readManifest(entityHash, logicalPath)
			val normalized = normalizeFileManifest(raw)
			if (normalized == null) {
				brokenManifests.add(BrokenManifestRef(entityHash, logicalPath))
				continue
			}
			@Suppress("UNCHECKED_CAST")
			val parts = normalized["parts"] as? List<Any?> ?: emptyList()
			for (rawPart in parts) {
				val part = rawPart as Map<*, *>
				referenced.add(part["hash"] as String)
			}
		}
	}

	val candidates = ArrayList<GcChunkTarget>()
	var freedBytes = 0L
	val prefixEntries = try {
		withContext(Dispatchers.IO) {
			Files.newDirectoryStream(Paths.get(chunkStoreRoot())).use { it.toList() }
		}
	}
	catch (_: Throwable) {
		emptyList()
	}
	val root = Paths.get(chunkStoreRoot())
	for (prefixEntry in prefixEntries) {
		if (!Files.isDirectory(prefixEntry) || prefixEntry.fileName.toString().length != 2) continue
		val files = try {
			withContext(Dispatchers.IO) {
				Files.newDirectoryStream(prefixEntry).use { it.toList() }
			}
		}
		catch (_: Throwable) {
			continue
		}
		for (file in files) {
			val name = file.fileName.toString()
			if (!name.endsWith(".bin")) continue
			val hash = name.dropLast(4)
			if (isHex64(hash) == null || referenced.contains(hash)) continue
			val size = chunkFileSize(root.resolve(prefixEntry.fileName.toString()).resolve(name).toString())
			candidates.add(GcChunkTarget(hash, size))
			freedBytes += size
		}
	}

	return GarbageCollectionReport(
		manifests = manifests,
		brokenManifests = brokenManifests,
		referenced = referenced.size.toLong(),
		candidates = candidates,
		deleted = 0,
		retained = 0,
		freedBytes = freedBytes,
		brokenDeleted = 0,
	)
}

/**
 * @param filePath chunk 文件绝对路径
 * @return 文件字节数；stat 失败为 0
 */
private suspend fun chunkFileSize(filePath: String): Long = withContext(Dispatchers.IO) {
	try {
		Files.size(Paths.get(filePath))
	}
	catch (_: Throwable) {
		0
	}
}

/**
 * 持锁删除一批 chunk，统计删除结果并顺带清理已空前缀目录。
 * @param hashes 待删 64 位 hex 集合
 * @return 删除结果统计
 */
private suspend fun removeChunkHashes(hashes: List<String>): RemoveResult {
	var deleted = 0L
	var retained = 0L
	var freedBytes = 0L
	val emptiedPrefixes = LinkedHashSet<String>()
	withChunkStoreLock {
		for (hash in hashes) {
			val result = unlinkChunkFile(hash)
			if (result.deleted) {
				deleted++
				freedBytes += result.size
				emptiedPrefixes.add(hash.substring(0, 2))
			}
			else retained++
		}
		withContext(Dispatchers.IO) {
			for (prefix in emptiedPrefixes) try {
				Files.delete(Paths.get(chunkStoreRoot(), prefix))
			}
			catch (_: Throwable) {
				// 目录非空或已被删，忽略
			}
		}
	}
	return RemoveResult(deleted, retained, freedBytes)
}

/**
 * 扫描并报告 chunk 垃圾（只读，不删除）。
 * @return 统计报告
 */
suspend fun mapChunkGarbage(): GarbageCollectionReport = scanChunkGarbage()

/**
 * 清理 chunk 垃圾。缺省 `targets` 时先扫描再删除（并自动清除扫描到的坏 manifest）；
 * 提供 `targets` 时只按给定集合删除，不做扫描、不碰 manifest。
 * @param targets 可选显式目标集（String 或 [GcChunkTarget]）
 * @return 执行报告
 */
suspend fun cleanChunkGarbage(targets: List<Any?>? = null): GarbageCollectionReport {
	if (targets != null) {
		val hashes = targets.map { target ->
			val hash = if (target is String) target else (target as? GcChunkTarget)?.hash
			if (isHex64(hash) == null)
				throw IllegalArgumentException("cleanChunkGarbage: invalid chunk hash ${jsString(hash)}")
			hash as String
		}
		val removed = removeChunkHashes(hashes)
		return GarbageCollectionReport(
			manifests = 0,
			brokenManifests = emptyList(),
			referenced = 0,
			candidates = hashes.map { GcChunkTarget(it, 0) },
			deleted = removed.deleted,
			retained = removed.retained,
			freedBytes = removed.freedBytes,
			brokenDeleted = 0,
		)
	}

	val snapshot = scanChunkGarbage()
	val entityStore = getEntityStore()
	val logger = getNodeLogger()
	var brokenDeleted = 0L
	if (snapshot.brokenManifests.isNotEmpty()) {
		for (broken in snapshot.brokenManifests) {
			entityStore.deleteManifest(broken.ownerEntityHash, broken.logicalPath)
			brokenDeleted++
		}
		logger?.info("chunk GC: removed $brokenDeleted broken manifest(s)")
	}

	val removed = removeChunkHashes(snapshot.candidates.map { it.hash })
	return snapshot.copy(
		deleted = removed.deleted,
		retained = removed.retained,
		freedBytes = removed.freedBytes,
		brokenDeleted = brokenDeleted,
	)
}
