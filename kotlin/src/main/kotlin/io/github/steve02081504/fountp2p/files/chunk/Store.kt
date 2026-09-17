package io.github.steve02081504.fountp2p.files.chunk

import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.node.getNodeDir
import io.github.steve02081504.fountp2p.utils.withAsyncMutex
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.nio.file.FileSystemException
import java.nio.file.Files
import java.nio.file.NoSuchFileException
import java.nio.file.Paths

/**
 * chunk 内容寻址存储（等价 `files/chunk/store.mjs`）。
 *
 * 布局：`{nodeDir}/chunks/<hash 前 2 位>/<hash>.bin`。
 *
 * 与 JS 的差异：JS 用 `node:fs` 的 ReadStream/WriteStream 与 `node:stream/promises.pipeline`；
 * Kotlin/JVM 以 suspend 文件 I/O 等价实现（`createChunkReadStream` 返回按块拉取的
 * [io.github.steve02081504.fountp2p.files.ByteChunkSource]，而非真实文件流）。
 */

/** chunk store 互斥键：GC 删除与写入互斥。 */
private const val CHUNK_STORE_LOCK_KEY = "chunk-store"

/** 删除结果。 */
data class ChunkUnlinkResult(
	/** 是否已删除；false 表示仍在被读（Windows open-handle） */
	val deleted: Boolean,
	/** 文件字节数 */
	val size: Long,
)

/**
 * chunk store 全局互斥锁（进程内）。
 * @param criticalSection 临界区
 * @return 临界区返回值
 */
suspend fun <T> withChunkStoreLock(criticalSection: suspend () -> T): T =
	withAsyncMutex(CHUNK_STORE_LOCK_KEY, criticalSection)

/** @return `{nodeDir}/chunks` */
fun chunkStoreRoot(): String = Paths.get(getNodeDir(), "chunks").toString()

/**
 * @param hash 64 位十六进制 ciphertextHash
 * @return 块文件绝对路径
 */
fun chunkStorePath(hash: String?): String {
	val valid = isHex64(hash) ?: throw IllegalArgumentException("invalid chunk hash")
	return Paths.get(chunkStoreRoot(), valid.substring(0, 2), "$valid.bin").toString()
}

/**
 * @param hash 64 位十六进制
 * @return 本地是否存在
 */
suspend fun hasChunk(hash: String): Boolean = withContext(Dispatchers.IO) {
	try {
		Files.exists(Paths.get(chunkStorePath(hash)))
	}
	catch (_: Throwable) {
		false
	}
}

/**
 * @param hash 64 位十六进制
 * @return 块字节
 */
suspend fun getChunk(hash: String): ByteArray = withContext(Dispatchers.IO) {
	Files.readAllBytes(Paths.get(chunkStorePath(hash)))
}

/**
 * @param hash 64 位十六进制
 * @return 可读数据源（整块一次性读入内存）
 */
suspend fun createChunkReadStream(hash: String): io.github.steve02081504.fountp2p.files.ByteChunkSource =
	io.github.steve02081504.fountp2p.files.chunkSourceOf(getChunk(hash))

/**
 * @param hash 64 位十六进制
 * @param data 块数据
 */
suspend fun putChunk(hash: String, data: ByteArray) {
	withChunkStoreLock { writeChunkFile(hash, data) }
}

/**
 * @param hash 64 位十六进制
 * @param readable 密文数据源
 */
suspend fun putChunkFromStream(hash: String, readable: io.github.steve02081504.fountp2p.files.ByteChunkSource) {
	withChunkStoreLock {
		val bytes = io.github.steve02081504.fountp2p.files.readAllChunks(readable)
		writeChunkFile(hash, bytes)
	}
}

private suspend fun writeChunkFile(hash: String, data: ByteArray) = withContext(Dispatchers.IO) {
	val path = Paths.get(chunkStorePath(hash))
	path.parent?.let { Files.createDirectories(it) }
	Files.write(path, data)
}

/**
 * @param hash 64 位十六进制
 * @return 删除结果；`deleted:false` 表示仍在被读（Windows open-handle）
 */
suspend fun unlinkChunkFile(hash: String): ChunkUnlinkResult = withContext(Dispatchers.IO) {
	val path = Paths.get(chunkStorePath(hash))
	try {
		val size = Files.size(path)
		Files.delete(path)
		ChunkUnlinkResult(true, size)
	}
	catch (_: NoSuchFileException) {
		ChunkUnlinkResult(true, 0)
	}
	catch (error: FileSystemException) {
		// Windows 上文件被读流打开时 unlink 会 EBUSY/EPERM——视为仍在使用，留给下次 GC。
		if (Files.exists(path)) ChunkUnlinkResult(false, 0)
		else throw error
	}
}

/**
 * 删除单个 chunk（带互斥锁）。重复删除视为成功。
 * @param hash 64 位十六进制
 * @return 删除结果
 */
suspend fun deleteChunk(hash: String): ChunkUnlinkResult =
	withChunkStoreLock { unlinkChunkFile(hash) }
