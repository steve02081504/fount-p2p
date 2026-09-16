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
 * 读取 JSONL 文件并解析为对象数组；缺失或读失败时返回空数组。
 * @param filePath 文件系统路径
 * @param sanitize 可选净化函数
 * @return 各行解析后的对象列表
 */
suspend fun readJsonl(
	filePath: String,
	sanitize: ((Map<String, Any?>) -> Map<String, Any?>)? = null,
): List<Map<String, Any?>> = withContext(Dispatchers.IO) {
	try {
		val text = Files.readString(Paths.get(filePath), Charsets.UTF_8)
		val snap = sanitize ?: { it }
		val rows = ArrayList<Map<String, Any?>>()
		for (line in text.split("\n")) {
			val row = parseJsonlLine(line, snap)
			if (row != null) rows.add(row)
		}
		rows
	}
	catch (_: Exception) {
		emptyList()
	}
}

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
	val reader = try {
		Files.newBufferedReader(Paths.get(filePath), Charsets.UTF_8)
	}
	catch (_: NoSuchFileException) {
		return@flow
	}
	reader.use {
		while (true) {
			val line = it.readLine() ?: break
			val row = parseJsonlLine(line, snap)
			if (row != null) emit(row)
		}
	}
}.flowOn(Dispatchers.IO)

/**
 * 流式过滤重写 JSONL：保留 `keep(row)===true` 的行。
 * @param filePath 目标路径
 * @param keep 保留谓词
 * @param sanitize 读行净化
 * @return kept 与 dropped 计数
 */
suspend fun rewriteJsonlKeeping(
	filePath: String,
	keep: (Map<String, Any?>) -> Boolean,
	sanitize: ((Map<String, Any?>) -> Map<String, Any?>)? = null,
): Pair<Int, Int> = withContext(Dispatchers.IO) {
	Paths.get(filePath).parent?.let { Files.createDirectories(it) }
	val temporaryPath = atomicTemporaryPath(filePath)
	val buffer = ArrayList<Map<String, Any?>>()
	var kept = 0
	var dropped = 0
	suspend fun flush() {
		if (buffer.isEmpty()) return
		val block = buildString {
			for (row in buffer) {
				append(Json.stringify(row) ?: "null")
				append('\n')
			}
		}
		Files.writeString(
			Paths.get(temporaryPath),
			block,
			Charsets.UTF_8,
			StandardOpenOption.CREATE,
			StandardOpenOption.APPEND,
		)
		buffer.clear()
	}
	try {
		readJsonlStream(filePath, sanitize).collect { row ->
			if (keep(row)) {
				buffer.add(row)
				kept++
				if (buffer.size >= WRITE_JSONL_CHUNK_LINES) flush()
			}
			else dropped++
		}
		flush()
	}
	catch (_: Exception) {
		// source missing
	}
	if (kept > 0 || dropped > 0)
		finalizeAtomicRename(temporaryPath, filePath)
	else
		try {
			Files.writeString(Paths.get(filePath), "", Charsets.UTF_8)
		}
		catch (_: Exception) {
			// ok
		}

	kept to dropped
}

/**
 * 读取 JSONL 末行事件的 `id`（DAG tip）；空文件为 null。
 * @param filePath 文件路径
 * @return tip event id
 */
suspend fun readJsonlTipId(filePath: String): String? = withContext(Dispatchers.IO) {
	try {
		FileChannel.open(Paths.get(filePath), StandardOpenOption.READ).use { channel ->
			val size = channel.size()
			if (size == 0L) return@withContext null
			val chunk = minOf(size, 65_536L).toInt()
			val buffer = ByteBuffer.allocate(chunk)
			channel.read(buffer, size - chunk)
			buffer.flip()
			val text = Charsets.UTF_8.decode(buffer).toString()
			val lines = text.split("\n").filter { it.isNotEmpty() }
			val last = lines.lastOrNull() ?: return@withContext null
			val row = Json.parse(last)
			val id = (row as? Map<*, *>)?.get("id")
			if (id == null) null else jsStringValue(id)
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
 * 流式重写 JSONL（临时文件 + rename），避免大数组 join 的内存峰值。
 * @param filePath 目标路径
 * @param records 行对象列表
 */
suspend fun writeJsonl(filePath: String, records: List<Map<String, Any?>>): Unit = withContext(Dispatchers.IO) {
	Paths.get(filePath).parent?.let { Files.createDirectories(it) }
	val temporaryPath = atomicTemporaryPath(filePath)
	Files.newBufferedWriter(
		Paths.get(temporaryPath),
		Charsets.UTF_8,
		StandardOpenOption.CREATE,
		StandardOpenOption.TRUNCATE_EXISTING,
		StandardOpenOption.WRITE,
	).use { writer ->
		for (rec in records) {
			writer.write(Json.stringify(rec) ?: "null")
			writer.write("\n")
		}
	}
	finalizeAtomicRename(temporaryPath, filePath)
}

/**
 * @param filePath JSONL 路径
 * @return 进程内互斥键
 */
fun jsonlMutexKey(filePath: String): String = "jsonl:$filePath"

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
suspend fun appendJsonlSynced(filePath: String, record: Map<String, Any?>): Unit = withContext(Dispatchers.IO) {
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
