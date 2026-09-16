package io.github.steve02081504.fountp2p.utils

import kotlinx.coroutines.delay
import java.io.IOException
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.NoSuchFileException
import java.nio.file.Paths
import java.nio.file.StandardCopyOption
import java.util.UUID

/**
 * 原子落盘：唯一临时路径 + rename（Windows 短暂占用时短退避重试）。
 */

/** Windows 上 rename 可能被短暂占用，做几次短退避重试。 */
private val ATOMIC_RENAME_RETRY_DELAYS_MS = longArrayOf(0, 10, 25, 50, 100, 200, 400)

/**
 * @param filePath 目标路径
 * @return 唯一临时文件路径
 */
fun atomicTemporaryPath(filePath: String): String =
	"$filePath.tmp.${ProcessHandle.current().pid()}.${UUID.randomUUID()}"

/**
 * 单次 rename 尝试；优先 ATOMIC_MOVE（Windows `MoveFileEx` 原子替换），
 * 不支持时退回 `REPLACE_EXISTING`。
 */
private fun tryMove(temporaryPath: String, filePath: String) {
	val source = Paths.get(temporaryPath)
	val target = Paths.get(filePath)
	try {
		Files.move(source, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
	}
	catch (_: AtomicMoveNotSupportedException) {
		Files.move(source, target, StandardCopyOption.REPLACE_EXISTING)
	}
}

/**
 * 完成原子写的最终 rename；若目标目录已在 cleanup 中消失，则清理残余临时文件后静默返回。
 * @param temporaryPath 临时文件路径
 * @param filePath 最终目标路径
 * @return 是否已成功落到目标路径
 */
suspend fun finalizeAtomicRename(temporaryPath: String, filePath: String): Boolean {
	var lastError: IOException? = null
	for (delayMs in ATOMIC_RENAME_RETRY_DELAYS_MS) {
		if (delayMs > 0) delay(delayMs)
		try {
			tryMove(temporaryPath, filePath)
			return true
		}
		catch (error: IOException) {
			lastError = error
			// 源临时文件已消失（目录被并发清理）时无需重试。
			if (error is NoSuchFileException) break
		}
	}
	cleanupAtomicTemporary(temporaryPath)
	if (lastError is NoSuchFileException) return false
	throw lastError ?: IOException("atomic rename failed for $filePath")
}

/**
 * `finalizeAtomicRename` 的同步版。
 * @param temporaryPath 临时文件路径
 * @param filePath 最终目标路径
 * @return 是否已成功落到目标路径
 */
fun finalizeAtomicRenameSync(temporaryPath: String, filePath: String): Boolean {
	var lastError: IOException? = null
	for (delayMs in ATOMIC_RENAME_RETRY_DELAYS_MS) {
		if (delayMs > 0) Thread.sleep(delayMs)
		try {
			tryMove(temporaryPath, filePath)
			return true
		}
		catch (error: IOException) {
			lastError = error
			if (error is NoSuchFileException) break
		}
	}
	cleanupAtomicTemporarySync(temporaryPath)
	if (lastError is NoSuchFileException) return false
	throw lastError ?: IOException("atomic rename failed for $filePath")
}

private fun cleanupAtomicTemporary(temporaryPath: String) {
	try {
		Files.deleteIfExists(Paths.get(temporaryPath))
	}
	catch (_: IOException) {
		// ok
	}
}

private fun cleanupAtomicTemporarySync(temporaryPath: String) {
	cleanupAtomicTemporary(temporaryPath)
}
