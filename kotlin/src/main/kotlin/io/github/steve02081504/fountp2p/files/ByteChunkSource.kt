package io.github.steve02081504.fountp2p.files

import io.github.steve02081504.fountp2p.federation.jsNumber
import io.github.steve02081504.fountp2p.federation.jsString
import io.github.steve02081504.fountp2p.federation.jsTruthy
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.InputStream

/**
 * 等价 JS `Readable` 的最小拉取接口：`read()` 返回下一块字节，流结束返回 `null`。
 *
 * JS 侧 `files/` 用 `node:stream` 的 `Readable`（`Readable.from([...])`、文件读流等）。
 * Kotlin/JVM 无等价对象，故以本接口抽象；`null` 等价「流已结束」。
 */
interface ByteChunkSource {
	/** @return 下一块字节；流结束为 `null` */
	suspend fun read(): ByteArray?
}

/**
 * 固定块序列数据源（等价 `Readable.from(chunks)`）。
 * @param chunks 依次产出的块
 */
fun chunkSourceOf(vararg chunks: ByteArray): ByteChunkSource = ListChunkSource(chunks.toList())

/**
 * @param chunks 依次产出的块
 * @return 固定块序列数据源
 */
fun chunkSourceOf(chunks: List<ByteArray>): ByteChunkSource = ListChunkSource(chunks)

private class ListChunkSource(private val chunks: List<ByteArray>) : ByteChunkSource {
	private var index = 0

	override suspend fun read(): ByteArray? =
		if (index < chunks.size) chunks[index++] else null
}

/**
 * 把 [InputStream] 适配为 [ByteChunkSource]（按 64 KiB 读取）。
 * @param input 输入流
 * @return 数据源；读取到 EOF 返回 `null`
 */
fun inputStreamChunkSource(input: InputStream): ByteChunkSource = object : ByteChunkSource {
	override suspend fun read(): ByteArray? = withContext(Dispatchers.IO) {
		val buffer = ByteArray(64 * 1024)
		val count = input.read(buffer)
		if (count < 0) null else buffer.copyOf(count)
	}
}

/** @return 读尽 [source] 的全部字节 */
suspend fun readAllChunks(source: ByteChunkSource): ByteArray {
	var out = ByteArray(0)
	while (true) {
		val chunk = source.read() ?: break
		if (chunk.isNotEmpty()) out += chunk
	}
	return out
}

/**
 * 等价 JS `a || b`（用于 `x || ''` / `Number(x) || 0` 形态）。
 * @param value 左操作数
 * @param fallback 兜底值
 * @return 真值时为 `String(value)`，否则 [fallback]
 */
internal fun jsStringOr(value: Any?, fallback: String): String =
	if (jsTruthy(value)) jsString(value) else fallback

/**
 * 等价 JS `Number(value) || fallback`。
 * @param value 左操作数
 * @param fallback 兜底值
 * @return 数值
 */
internal fun jsNumberOr(value: Any?, fallback: Double): Double {
	val number = jsNumber(value)
	return if (number.isNaN() || number == 0.0) fallback else number
}
