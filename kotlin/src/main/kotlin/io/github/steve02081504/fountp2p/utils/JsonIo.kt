package io.github.steve02081504.fountp2p.utils

import io.github.steve02081504.fountp2p.core.Json
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Paths

/**
 * @param filePath 绝对路径
 * @return JSON 或 null
 */
suspend fun readJsonFile(filePath: String): Any? = withContext(Dispatchers.IO) { readJsonFileSync(filePath) }

/**
 * @param filePath 绝对路径
 * @param data 可序列化对象
 */
suspend fun writeJsonFile(filePath: String, data: Any?): Unit = withAsyncMutex(filePath) {
	withContext(Dispatchers.IO) { writeJsonFileSync(filePath, data) }
}

/**
 * @param filePath 绝对路径
 * @return JSON 或 null
 */
fun readJsonFileSync(filePath: String): Any? {
	val raw = try {
		Files.readString(Paths.get(filePath), Charsets.UTF_8)
	}
	catch (error: java.nio.file.NoSuchFileException) {
		return null
	}
	return Json.parse(raw)
}

/**
 * @param filePath 绝对路径
 * @param data 可序列化对象
 */
fun writeJsonFileSync(filePath: String, data: Any?) {
	val path = Paths.get(filePath)
	path.parent?.let { Files.createDirectories(it) }
	val temporaryPath = atomicTemporaryPath(filePath)
	Files.writeString(Paths.get(temporaryPath), "${Json.stringify(data, 2)}\n", Charsets.UTF_8)
	if (!finalizeAtomicRenameSync(temporaryPath, filePath))
		throw IOException("ENOENT: atomic rename failed for $filePath")
}
