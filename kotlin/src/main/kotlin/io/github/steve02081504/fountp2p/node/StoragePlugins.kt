package io.github.steve02081504.fountp2p.node

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.nio.file.Files
import java.nio.file.NoSuchFileException
import java.nio.file.Paths

/**
 * 群组分块存储插件：put/get/delete + 不透明 storageLocator（等价 `node/storage_plugins.mjs`）。
 * S3、多副本等后端由 shell 注入实现，本包只提供本地参考实现。
 */

/** 存储定位符结果：`{ storageLocator }`。 */
data class StoredChunk(val storageLocator: String)

/** 群组分块存储插件。 */
interface GroupStoragePlugin {
	/** 存储节点标识（本地实现为 `local`）。 */
	val storagePeerId: String

	/**
	 * @param groupId 群组 id
	 * @param chunkHash 分块内容哈希（文件名）
	 * @param data 原始字节
	 * @return 定位符
	 */
	suspend fun putChunk(groupId: String, chunkHash: String, data: ByteArray): StoredChunk

	/** @param locator 定位符 @return 文件内容 */
	suspend fun getChunk(locator: String): ByteArray

	/** @param locator 定位符 */
	suspend fun deleteChunk(locator: String)
}

/** `local:<groupId>/chunks/<name>` 定位符。 */
private val LOCAL_LOCATOR_RE = Regex("^local:([^/]+)/chunks/(.+)$")

/**
 * 默认：本地目录 `{baseDir}/groups/{groupId}/chunks/`（baseDir 一般为用户 shells/chat）。
 * @param baseDir 绝对路径
 * @return 本地文件系统实现的 put/get/delete
 */
fun createLocalStoragePlugin(baseDir: String): GroupStoragePlugin = object : GroupStoragePlugin {
	override val storagePeerId: String = "local"

	override suspend fun putChunk(groupId: String, chunkHash: String, data: ByteArray): StoredChunk =
		withContext(Dispatchers.IO) {
			val dir = Paths.get(baseDir, "groups", groupId, "chunks")
			Files.createDirectories(dir)
			val name = "$chunkHash.bin"
			Files.write(dir.resolve(name), data)
			StoredChunk("local:$groupId/chunks/$name")
		}

	override suspend fun getChunk(locator: String): ByteArray = withContext(Dispatchers.IO) {
		val match = LOCAL_LOCATOR_RE.matchEntire(locator)
			?: throw IllegalArgumentException("Invalid local locator")
		val chunkPath = Paths.get(baseDir, "groups", match.groupValues[1], "chunks", match.groupValues[2])
		Files.readAllBytes(chunkPath)
	}

	override suspend fun deleteChunk(locator: String): Unit = withContext(Dispatchers.IO) {
		val match = LOCAL_LOCATOR_RE.matchEntire(locator) ?: return@withContext
		val chunkPath = Paths.get(baseDir, "groups", match.groupValues[1], "chunks", match.groupValues[2])
		try {
			Files.delete(chunkPath)
		}
		catch (_: NoSuchFileException) {
			// ok
		}
	}
}
