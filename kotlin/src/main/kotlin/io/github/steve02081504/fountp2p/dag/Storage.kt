package io.github.steve02081504.fountp2p.dag

import io.github.steve02081504.fountp2p.core.Json
import io.github.steve02081504.fountp2p.core.JsonUndefined
import io.github.steve02081504.fountp2p.utils.atomicTemporaryPath
import io.github.steve02081504.fountp2p.utils.finalizeAtomicRename
import io.github.steve02081504.fountp2p.utils.withAsyncMutex
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.withContext
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.NoSuchFileException
import java.nio.file.Paths
import java.nio.file.StandardOpenOption

/**
 * DAG JSONL 存储辅助（`dag/storage.mjs` 的等价实现）。
 *
 * 行为注意：JS 允许 JSONL 行解析出非对象值，本实现按包约定只接受对象行，
 * 非对象行按坏行跳过（实际调用方均为事件/记录对象）。
 */

/** 流式重写 JSONL 时分块写入的行数上限。 */
private const val WRITE_JSONL_CHUNK_LINES = 1000

/** 类型断言的 JSON 对象视图（[Json.parse] 的对象即 [LinkedHashMap]）。 */
@Suppress("UNCHECKED_CAST")
private fun asJsonObject(value: Any?): Map<String, Any?>? = value as? Map<String, Any?>

/**
 * @param line JSONL 单行
 * @param sanitize 行净化
 * @return 解析后的对象；坏行/空行返回 null
 */
private fun parseJsonlLine(
	line: String,
	sanitize: (Map<String, Any?>) -> Map<String, Any?>,
): Map<String, Any?>? {
	val trimmed = line.trim()
	if (trimmed.isEmpty()) return null
	return try {
		val parsed = asJsonObject(Json.parse(trimmed))
		if (parsed != null) sanitize(parsed) else null
	}
	catch (_: Exception) {
		null
	}
}

/**
 * 读取 JSONL 文件并解析为对象数组；文件缺失（ENOENT）时返回空数组，
 * 其他读取错误照常抛出（不再吞掉，避免把坏文件当成空日志）。
 * @param filePath 文件系统路径
 * @param sanitize 可选净化函数
 * @return 各行解析后的对象列表
 */
suspend fun readJsonl(
	filePath: String,
	sanitize: ((Map<String, Any?>) -> Map<String, Any?>)? = null,
): List<Map<String, Any?>> = readJsonlEntries(filePath, sanitize).map { it.row }

/**
 * 逐行读取 JSONL 原始文本（不 trim）。文件缺失（ENOENT）视为空流，
 * 兼容 cleanup 竞态：群目录被删后台仍在尾巴上读它；其他读取错误照常抛出。
 * @param filePath 文件路径
 * @return 原始行
 */
private fun readJsonlRawLines(filePath: String): Flow<String> = flow {
	val reader = try {
		Files.newBufferedReader(Paths.get(filePath), Charsets.UTF_8)
	}
	catch (_: NoSuchFileException) {
		return@flow
	}
	reader.use {
		while (true) {
			val line = it.readLine() ?: break
			emit(line)
		}
	}
}.flowOn(Dispatchers.IO)

/**
 * 流式读取 JSONL（避免整文件读入内存）。文件缺失（ENOENT）视为空流，
 * 兼容 cleanup 竞态：群目录被删后台仍在尾巴上读它。
 * @param filePath 文件路径
 * @param sanitize 行净化
 * @return 逐行事件
 */
fun readJsonlStream(
	filePath: String,
	sanitize: ((Map<String, Any?>) -> Map<String, Any?>)? = null,
): Flow<Map<String, Any?>> = flow {
	val snap = sanitize ?: { it }
	readJsonlRawLines(filePath).collect { line ->
		val row = parseJsonlLine(line, snap)
		if (row != null) emit(row)
	}
}.flowOn(Dispatchers.IO)

/**
 * JSONL 原始条目：解析并净化后的 [row] 与磁盘上的原始 [raw] 行（不含换行）。
 * @param row 解析并净化后的对象
 * @param raw 原始行
 */
data class JsonlEntry(val row: Map<String, Any?>, val raw: String)

/**
 * 读取 JSONL 为 [JsonlEntry] 列表：空白行跳过，解析/净化失败的行跳过；
 * 文件缺失返回空列表，其他读取错误抛出。
 * @param filePath 文件路径
 * @param sanitize 行净化
 * @return 条目列表
 */
suspend fun readJsonlEntries(
	filePath: String,
	sanitize: ((Map<String, Any?>) -> Map<String, Any?>)? = null,
): List<JsonlEntry> {
	val snap = sanitize ?: { it }
	val entries = ArrayList<JsonlEntry>()
	readJsonlRawLines(filePath).collect { raw ->
		val row = parseJsonlLine(raw, snap)
		if (row != null) entries.add(JsonlEntry(row, raw))
	}
	return entries
}

/**
 * 流式过滤重写 JSONL：保留 `keep(row)===true` 的行。
 *
 * 在 [jsonlMutexKey] per-file 互斥锁内执行，与 [appendJsonlSynced] / [writeJsonlSynced] 共享。
 * 该锁不可重入：调用方不要在已持有同一文件锁的临界区内再次调用本函数或其他 synced 写入。
 *
 * [sanitize] 只影响传给 [keep] 的对象；落盘时写回磁盘上的原始行，不做再序列化。
 * 未丢弃任何行时不重命名（保留原 inode/字节/mtime）；任何失败（I/O、keep 抛错、取消）
 * 都会清理临时文件并原样抛出，绝不触碰原文件。
 *
 * @param filePath 目标路径
 * @param keep 保留谓词
 * @param sanitize 读行净化
 * @return kept 与 dropped 计数
 */
suspend fun rewriteJsonlKeeping(
	filePath: String,
	keep: (Map<String, Any?>) -> Boolean,
	sanitize: ((Map<String, Any?>) -> Map<String, Any?>)? = null,
): Pair<Int, Int> = withAsyncMutex(jsonlMutexKey(filePath)) {
	withContext(Dispatchers.IO) { rewriteJsonlKeepingLocked(filePath, keep, sanitize) }
}

/** [rewriteJsonlKeeping] 的持锁实现体。 */
private suspend fun rewriteJsonlKeepingLocked(
	filePath: String,
	keep: (Map<String, Any?>) -> Boolean,
	sanitize: ((Map<String, Any?>) -> Map<String, Any?>)?,
): Pair<Int, Int> {
	val snap = sanitize ?: { it }
	val temporaryPath = atomicTemporaryPath(filePath)
	val buffered = ArrayList<String>()
	var channel: FileChannel? = null
	var kept = 0
	var dropped = 0

	fun ensureChannel(): FileChannel {
		var open = channel
		if (open == null) {
			open = FileChannel.open(
				Paths.get(temporaryPath),
				StandardOpenOption.CREATE,
				StandardOpenOption.TRUNCATE_EXISTING,
				StandardOpenOption.WRITE,
			)
			channel = open
		}
		return open
	}

	fun flush() {
		if (buffered.isEmpty()) return
		val target = ensureChannel()
		for (raw in buffered) {
			val buffer = ByteBuffer.wrap((raw + "\n").toByteArray(Charsets.UTF_8))
			while (buffer.hasRemaining()) target.write(buffer)
		}
		buffered.clear()
	}

	fun discardTemp() {
		try {
			channel?.close()
		}
		catch (_: Exception) {
			// ok
		}
		channel = null
		try {
			Files.deleteIfExists(Paths.get(temporaryPath))
		}
		catch (_: Exception) {
			// ok
		}
	}

	try {
		readJsonlRawLines(filePath).collect { raw ->
			if (raw.isBlank()) return@collect
			val row = parseJsonlLine(raw, snap)
			if (row == null) {
				dropped++
				return@collect
			}
			if (keep(row)) {
				buffered.add(raw)
				kept++
				if (buffered.size >= WRITE_JSONL_CHUNK_LINES) flush()
			}
			else dropped++
		}
		flush()

		if (dropped == 0) {
			discardTemp()
			return kept to dropped
		}

		val target = ensureChannel()
		target.force(true)
		target.close()
		channel = null
		finalizeAtomicRename(temporaryPath, filePath)
		return kept to dropped
	}
	catch (error: Throwable) {
		discardTemp()
		throw error
	}
}

/** 读取 DAG tip 时回看的尾部字节数上限（1 MiB）。 */
private const val READ_TIP_TAIL_BYTES = 1_048_576L

/**
 * 读取 JSONL 末行事件的 `id`（DAG tip）；空文件为 null。
 * 在尾块内从后往前找第一个可解析且 `id` 非 null 的非空行（末行可能被截断）。
 * @param filePath 文件路径
 * @return tip event id
 */
suspend fun readJsonlTipId(filePath: String): String? = withContext(Dispatchers.IO) {
	try {
		FileChannel.open(Paths.get(filePath), StandardOpenOption.READ).use { channel ->
			val size = channel.size()
			if (size == 0L) return@withContext null
			val chunk = minOf(size, READ_TIP_TAIL_BYTES).toInt()
			val buffer = ByteBuffer.allocate(chunk)
			var position = size - chunk
			while (buffer.hasRemaining()) {
				val read = channel.read(buffer, position)
				if (read < 0) break
				position += read
			}
			buffer.flip()
			val text = Charsets.UTF_8.decode(buffer).toString()
			for (line in text.split("\n").asReversed()) {
				if (line.isBlank()) continue
				val id = try {
					(Json.parse(line.trim()) as? Map<*, *>)?.get("id")
				}
				catch (_: Exception) {
					null
				}
				if (id != null) return@withContext jsStringValue(id)
			}
			null
		}
	}
	catch (_: Exception) {
		null
	}
}

/** `String(value)` 对 JSON 值的等价（id 通常为字符串）。 */
private fun jsStringValue(value: Any?): String = when (value) {
	is String -> value
	is Boolean -> value.toString()
	is Number -> Json.jsNumberToString(value.toDouble())
	is Map<*, *> -> "[object Object]"
	is List<*> -> value.joinToString(",") { jsStringValue(it) }
	else -> value.toString()
}

/**
 * 原子写入原始 JSONL 行（每行追加换行；临时文件 `fsync` 后 rename）。
 * 不取 per-file 互斥锁；需要串行请用 [writeJsonlSynced]。
 * @param filePath 目标路径
 * @param lines 原始行（不含换行）
 */
suspend fun writeJsonlLines(filePath: String, lines: List<String>): Unit = withContext(Dispatchers.IO) {
	Paths.get(filePath).parent?.let { Files.createDirectories(it) }
	val temporaryPath = atomicTemporaryPath(filePath)
	FileChannel.open(
		Paths.get(temporaryPath),
		StandardOpenOption.CREATE,
		StandardOpenOption.TRUNCATE_EXISTING,
		StandardOpenOption.WRITE,
	).use { channel ->
		for (line in lines) {
			val buffer = ByteBuffer.wrap((line + "\n").toByteArray(Charsets.UTF_8))
			while (buffer.hasRemaining()) channel.write(buffer)
		}
		channel.force(true)
	}
	finalizeAtomicRename(temporaryPath, filePath)
}

/**
 * 流式重写 JSONL（临时文件 + rename），避免大数组 join 的内存峰值。
 * @param filePath 目标路径
 * @param records 行对象列表
 */
suspend fun writeJsonl(filePath: String, records: List<Map<String, Any?>>): Unit =
	writeJsonlLines(filePath, records.map { Json.stringify(it) ?: "null" })

/**
 * @param filePath JSONL 路径
 * @return 进程内互斥键（绝对化并归一化，相对/绝对写法共享同一锁）
 */
fun jsonlMutexKey(filePath: String): String =
	"jsonl:${Paths.get(filePath).toAbsolutePath().normalize()}"

/**
 * 在 per-file 互斥锁内流式重写 JSONL（Social / Mailbox 等非 Chat 群锁域）。
 * @param filePath 目标路径
 * @param records 行对象列表
 */
suspend fun writeJsonlSynced(filePath: String, records: List<Map<String, Any?>>): Unit =
	withAsyncMutex(jsonlMutexKey(filePath)) { writeJsonl(filePath, records) }

/**
 * 追加一行 JSONL 并 `fsync`。
 * @param filePath 目标路径
 * @param record 记录对象
 */
suspend fun appendJsonlSynced(filePath: String, record: Map<String, Any?>): Unit =
	withAsyncMutex(jsonlMutexKey(filePath)) {
		withContext(Dispatchers.IO) {
			Paths.get(filePath).parent?.let { Files.createDirectories(it) }
			FileChannel.open(
				Paths.get(filePath),
				StandardOpenOption.CREATE,
				StandardOpenOption.WRITE,
				StandardOpenOption.APPEND,
			).use { channel ->
				val bytes = ((Json.stringify(record) ?: "null") + "\n").toByteArray(Charsets.UTF_8)
				channel.write(ByteBuffer.wrap(bytes))
				channel.force(true)
			}
		}
	}

/**
 * 写入原子临时文件；若父目录已在 cleanup 竞态中消失（ENOENT）则返回 false。
 * @param temporaryPath 临时文件路径
 * @param data 文件内容
 * @return 是否已写入
 */
private suspend fun writeAtomicTemporary(temporaryPath: String, data: String): Boolean =
	withContext(Dispatchers.IO) {
		try {
			Files.writeString(Paths.get(temporaryPath), data, Charsets.UTF_8)
			true
		}
		catch (_: NoSuchFileException) {
			false
		}
	}

/**
 * 原子写入 JSON 文件（临时文件 + rename）。
 * @param filePath 目标路径
 * @param obj 可 JSON 序列化对象
 */
suspend fun writeJsonAtomic(filePath: String, obj: Any?): Unit = withContext(Dispatchers.IO) {
	Paths.get(filePath).parent?.let { Files.createDirectories(it) }
	val temporaryPath = atomicTemporaryPath(filePath)
	if (!writeAtomicTemporary(temporaryPath, tabIndentedJson(obj))) return@withContext
	finalizeAtomicRename(temporaryPath, filePath)
}

/**
 * 原子写入 JSON 并对目标文件 `fsync`。
 * @param filePath 目标路径
 * @param obj 可序列化对象
 */
suspend fun writeJsonAtomicSynced(filePath: String, obj: Any?): Unit = withContext(Dispatchers.IO) {
	Paths.get(filePath).parent?.let { Files.createDirectories(it) }
	val temporaryPath = atomicTemporaryPath(filePath)
	if (!writeAtomicTemporary(temporaryPath, tabIndentedJson(obj))) return@withContext
	FileChannel.open(Paths.get(temporaryPath), StandardOpenOption.READ, StandardOpenOption.WRITE).use { it.force(true) }
	if (!finalizeAtomicRename(temporaryPath, filePath)) return@withContext
	FileChannel.open(Paths.get(filePath), StandardOpenOption.READ, StandardOpenOption.WRITE).use { it.force(true) }
}

/**
 * 等价 `JSON.stringify(value, null, '\t')`（TAB 缩进美化）。
 * 标量/字符串转义复用 [Json.stringify]，避免与 core 实现漂移。
 * @param value JSON 值
 * @return TAB 缩进的 JSON 文本
 */
private fun tabIndentedJson(value: Any?): String = tabIndentedJsonAt(value, 0)

/** [tabIndentedJson] 的定深版（[depth] 为当前缩进层数）。 */
private fun tabIndentedJsonAt(value: Any?, depth: Int): String = when (value) {
	is Map<*, *> -> {
		val entries = value.entries.filter { it.key is String && it.value !== JsonUndefined }
		if (entries.isEmpty()) "{}"
		else entries.joinToString(
			separator = ",\n",
			prefix = "{\n",
			postfix = "\n" + "\t".repeat(depth) + "}",
		) { (key, entryValue) ->
			"\t".repeat(depth + 1) + Json.stringify(key as String) + ": " + tabIndentedJsonAt(entryValue, depth + 1)
		}
	}
	is List<*> -> if (value.isEmpty()) "[]" else value.joinToString(
		separator = ",\n",
		prefix = "[\n",
		postfix = "\n" + "\t".repeat(depth) + "]",
	) { "\t".repeat(depth + 1) + tabIndentedJsonAt(it, depth + 1) }
	else -> Json.stringify(value) ?: "null"
}
