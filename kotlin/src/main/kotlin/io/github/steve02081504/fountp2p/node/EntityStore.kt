package io.github.steve02081504.fountp2p.node

import io.github.steve02081504.fountp2p.core.assertSafeEvfsLogicalPath
import io.github.steve02081504.fountp2p.core.parseEntityHash
import io.github.steve02081504.fountp2p.utils.readJsonFile
import io.github.steve02081504.fountp2p.utils.writeJsonFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.nio.file.Files
import java.nio.file.NoSuchFileException
import java.nio.file.Path
import java.nio.file.Paths

/**
 * 实体文件 store 抽象（等价 `node/entity_store.mjs` 的 `EntityStore`）。
 */
interface EntityStore {
	/** @return 本 store 下全部 entityHash */
	suspend fun listEntityHashes(): List<String>

	/** @param entityHash 128 位十六进制 @param name 相对 JSON 名 @return 解析后的 JSON 或 null */
	suspend fun readEntityJson(entityHash: String, name: String): Any?

	/** @param entityHash 128 位十六进制 @param name 相对 JSON 名 @param data 写入对象 */
	suspend fun writeEntityJson(entityHash: String, name: String, data: Any?)

	/** @param entityHash 128 位十六进制 @param logicalPath EVFS 逻辑路径 @return 明文文件或 null */
	suspend fun readEntityFile(entityHash: String, logicalPath: String): ByteArray?

	/** @param entityHash 128 位十六进制 @param logicalPath EVFS 逻辑路径 @param data 明文内容 */
	suspend fun writeEntityFile(entityHash: String, logicalPath: String, data: ByteArray)

	/** @param entityHash 128 位十六进制 @param logicalPath EVFS 逻辑路径 @return 明文文件是否存在 */
	suspend fun statEntityFile(entityHash: String, logicalPath: String): Boolean

	/** @param entityHash 128 位十六进制 @return 逻辑路径列表 */
	suspend fun listEntityFiles(entityHash: String): List<String>

	/** @param entityHash 128 位十六进制 @param logicalPath EVFS 逻辑路径 @return manifest 或 null */
	suspend fun readManifest(entityHash: String, logicalPath: String): Any?

	/** @param entityHash 128 位十六进制 @param logicalPath EVFS 逻辑路径 @param data manifest 对象 */
	suspend fun writeManifest(entityHash: String, logicalPath: String, data: Any?)

	/** @param entityHash 128 位十六进制 @param logicalPath EVFS 逻辑路径 @return manifest 是否存在 */
	suspend fun statManifest(entityHash: String, logicalPath: String): Boolean

	/** @param entityHash 128 位十六进制 @param logicalPath EVFS 逻辑路径 删除 manifest（不存在视为成功） */
	suspend fun deleteManifest(entityHash: String, logicalPath: String)
}

/**
 * @param entityHash 128 位十六进制
 * @return 规范化 entityHash
 */
private fun normalizeEntityHash(entityHash: String): String =
	parseEntityHash(entityHash)?.entityHash ?: throw IllegalArgumentException("invalid entityHash")

/**
 * 默认文件系统 EntityStore（等价 JS `createFsEntityStore`）。
 * @param baseDir entities 根目录
 * @return put/get 文件系统实现
 */
fun createFsEntityStore(baseDir: String): EntityStore {
	val root = Paths.get(baseDir).toAbsolutePath().normalize()

	/** @return 实体目录绝对路径 */
	fun entityRoot(entityHash: String): Path = root.resolve(normalizeEntityHash(entityHash))

	/** @return JSON 文件绝对路径 */
	fun entityJsonPath(entityHash: String, name: String): Path {
		val safe = name.replace('\\', '/')
		if (safe.isEmpty() || safe.contains("..") || safe.startsWith("/")) throw IllegalArgumentException("invalid entity json name")
		return entityRoot(entityHash).resolve(safe)
	}

	/** @return manifest 绝对路径 */
	fun manifestPath(entityHash: String, logicalPath: String): Path {
		val filesRoot = entityRoot(entityHash).resolve("files")
		val safe = assertSafeEvfsLogicalPath(logicalPath)
		val resolved = filesRoot.resolve("$safe.manifest.json").normalize()
		val rootResolved = filesRoot.normalize()
		if (resolved != rootResolved && !resolved.startsWith(rootResolved))
			throw IllegalArgumentException("invalid EVFS path traversal")
		return resolved
	}

	/** @return manifest 去掉后缀后的明文文件路径 */
	fun plainFilePath(entityHash: String, logicalPath: String): Path {
		val manifest = manifestPath(entityHash, logicalPath)
		val text = manifest.toString()
		val suffix = ".manifest.json"
		return Paths.get(if (text.endsWith(suffix)) text.substring(0, text.length - suffix.length) else text)
	}

	return object : EntityStore {
		override suspend fun listEntityHashes(): List<String> = withContext(Dispatchers.IO) {
			if (!Files.isDirectory(root)) return@withContext emptyList()
			val out = ArrayList<String>()
			Files.newDirectoryStream(root).use { stream ->
				for (entry in stream) {
					if (!Files.isDirectory(entry)) continue
					val name = entry.fileName.toString()
					if (parseEntityHash(name) != null) out.add(name)
				}
			}
			out
		}

		override suspend fun readEntityJson(entityHash: String, name: String): Any? =
			readJsonFile(entityJsonPath(entityHash, name).toString())

		override suspend fun writeEntityJson(entityHash: String, name: String, data: Any?) {
			writeJsonFile(entityJsonPath(entityHash, name).toString(), data)
		}

		override suspend fun readEntityFile(entityHash: String, logicalPath: String): ByteArray? =
			withContext(Dispatchers.IO) {
				try {
					Files.readAllBytes(plainFilePath(entityHash, logicalPath))
				}
				catch (_: NoSuchFileException) {
					null
				}
			}

		override suspend fun writeEntityFile(entityHash: String, logicalPath: String, data: ByteArray): Unit =
			withContext(Dispatchers.IO) {
				val filePath = plainFilePath(entityHash, logicalPath)
				filePath.parent?.let { Files.createDirectories(it) }
				Files.write(filePath, data)
			}

		override suspend fun statEntityFile(entityHash: String, logicalPath: String): Boolean =
			withContext(Dispatchers.IO) { Files.exists(plainFilePath(entityHash, logicalPath)) }

		override suspend fun listEntityFiles(entityHash: String): List<String> = withContext(Dispatchers.IO) {
			val filesRoot = entityRoot(entityHash).resolve("files")
			val out = ArrayList<String>()

			fun walk(dir: Path, prefix: String) {
				if (!Files.isDirectory(dir)) return
				Files.newDirectoryStream(dir).use { stream ->
					for (entry in stream) {
						val name = entry.fileName.toString()
						val rel = if (prefix.isEmpty()) name else "$prefix/$name"
						if (Files.isDirectory(entry)) walk(entry, rel)
						else if (name.endsWith(".manifest.json"))
							out.add(rel.substring(0, rel.length - ".manifest.json".length))
					}
				}
			}

			walk(filesRoot, "")
			out
		}

		override suspend fun readManifest(entityHash: String, logicalPath: String): Any? =
			readJsonFile(manifestPath(entityHash, logicalPath).toString())

		override suspend fun writeManifest(entityHash: String, logicalPath: String, data: Any?) {
			writeJsonFile(manifestPath(entityHash, logicalPath).toString(), data)
		}

		override suspend fun statManifest(entityHash: String, logicalPath: String): Boolean =
			withContext(Dispatchers.IO) { Files.exists(manifestPath(entityHash, logicalPath)) }

		override suspend fun deleteManifest(entityHash: String, logicalPath: String): Unit =
			withContext(Dispatchers.IO) {
				try {
					Files.delete(manifestPath(entityHash, logicalPath))
				}
				catch (_: NoSuchFileException) {
					// ok
				}
			}
	}
}
