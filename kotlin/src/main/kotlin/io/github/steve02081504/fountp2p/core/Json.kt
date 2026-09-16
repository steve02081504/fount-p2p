package io.github.steve02081504.fountp2p.core

import com.google.gson.JsonElement
import com.google.gson.JsonParser
import java.math.BigDecimal

/**
 * `undefined` 哨兵：对应 JS 的 `undefined`（Kotlin 无法区分「缺失」与「null」）。
 *
 * 仅用于忠实移植 JS 语义：对象中值为 [JsonUndefined] 的键在序列化时被跳过，
 * 数组中的 [JsonUndefined] 元素序列化为 `null`。
 */
object JsonUndefined

/** JSON 对象：键为 String，值为 [JsonValue]。 */
typealias JsonObject = Map<String, Any?>

/** JSON 数组。 */
typealias JsonArray = List<Any?>

/**
 * JSON 值域：`null` / [JsonUndefined] / `Boolean` / `Double` / `String` / [JsonObject] / [JsonArray]。
 *
 * 数字一律以 `Double` 承载（与 JS `JSON.parse` 一致）；需要整数时用 [Json.long] / [Json.int]。
 */
object Json {
	/**
	 * 严格 JSON 解析（等价 `JSON.parse`）。
	 * @param text JSON 文本
	 * @return JSON 值
	 */
	fun parse(text: String): Any? = fromGson(JsonParser.parseString(text))

	private fun fromGson(element: JsonElement): Any? = when {
		element.isJsonNull -> null
		element.isJsonArray -> element.asJsonArray.map { fromGson(it) }
		element.isJsonObject -> {
			val out = LinkedHashMap<String, Any?>()
			for ((key, value) in element.asJsonObject.entrySet()) out[key] = fromGson(value)
			out
		}
		else -> {
			val primitive = element.asJsonPrimitive
			when {
				primitive.isBoolean -> primitive.asBoolean
				primitive.isString -> primitive.asString
				else -> primitive.asDouble
			}
		}
	}

	/**
	 * 等价 `JSON.stringify`：顶层为 [JsonUndefined] 时返回 `null`。
	 * @param value JSON 值
	 * @return 紧凑 JSON 文本；顶层 undefined 时为 `null`
	 */
	fun stringify(value: Any?): String? {
		if (value === JsonUndefined) return null
		val out = StringBuilder()
		writeValue(out, value, canonical = false)
		return out.toString()
	}

	/**
	 * 等价 `canonicalStringify`：对象键排序的确定性 JSON。
	 * @param value JSON 值
	 * @return 键已排序的紧凑 JSON 文本
	 */
	fun stringifyCanonical(value: Any?): String {
		val out = StringBuilder()
		writeValue(out, value, canonical = true)
		return out.toString()
	}

	/**
	 * 等价 `JSON.stringify(value, null, indent)`（缩进美化）。
	 * @param value JSON 值
	 * @param indent 缩进空格数
	 * @return 美化 JSON 文本；顶层 undefined 时为 `null`
	 */
	fun stringify(value: Any?, indent: Int): String? {
		if (value === JsonUndefined) return null
		val out = StringBuilder()
		writePretty(out, value, indent, 0)
		return out.toString()
	}

	/**
	 * `JSON.stringify(value)` 的 UTF-8 字节数（等价 `Buffer.byteLength`）。
	 * @param value JSON 值
	 * @return 字节数；不可序列化时为 `Int.MAX_VALUE`
	 */
	fun byteLength(value: Any?): Int {
		val text = stringify(value) ?: return Int.MAX_VALUE
		return text.toByteArray(Charsets.UTF_8).size
	}

	private fun writePretty(out: StringBuilder, value: Any?, indent: Int, depth: Int) {
		when (value) {
			is Map<*, *> -> {
				val entries = value.entries.filter { it.key is String && it.value !== JsonUndefined }
				if (entries.isEmpty()) {
					out.append("{}")
					return
				}
				out.append("{\n")
				val pad = " ".repeat(indent * (depth + 1))
				for ((index, entry) in entries.withIndex()) {
					out.append(pad)
					writeString(out, entry.key as String)
					out.append(": ")
					writePretty(out, entry.value, indent, depth + 1)
					if (index < entries.size - 1) out.append(',')
					out.append('\n')
				}
				out.append(" ".repeat(indent * depth)).append('}')
			}
			is List<*> -> {
				if (value.isEmpty()) {
					out.append("[]")
					return
				}
				out.append("[\n")
				val pad = " ".repeat(indent * (depth + 1))
				for ((index, item) in value.withIndex()) {
					out.append(pad)
					writePretty(out, item, indent, depth + 1)
					if (index < value.size - 1) out.append(',')
					out.append('\n')
				}
				out.append(" ".repeat(indent * depth)).append(']')
			}
			is Array<*> -> writePretty(out, value.toList(), indent, depth)
			else -> writeValue(out, value, canonical = false)
		}
	}

	private fun writeValue(out: StringBuilder, value: Any?, canonical: Boolean) {
		when (value) {
			null, JsonUndefined -> out.append("null")
			is Boolean -> out.append(if (value) "true" else "false")
			is Double -> out.append(jsNumberToString(value))
			is Float -> out.append(jsNumberToString(value.toDouble()))
			is Number -> out.append(jsNumberToString(value.toDouble()))
			is String -> writeString(out, value)
			is Map<*, *> -> writeObject(out, value, canonical)
			is List<*> -> writeArray(out, value, canonical)
			is Array<*> -> writeArray(out, value.toList(), canonical)
			else -> throw IllegalArgumentException("Unsupported JSON value: ${value::class}")
		}
	}

	private fun writeArray(out: StringBuilder, value: List<*>, canonical: Boolean) {
		out.append('[')
		for ((index, item) in value.withIndex()) {
			if (index > 0) out.append(',')
			writeValue(out, item, canonical)
		}
		out.append(']')
	}

	private fun writeObject(out: StringBuilder, value: Map<*, *>, canonical: Boolean) {
		val entries = value.entries.filter { it.key is String && it.value !== JsonUndefined }
		val ordered = if (canonical) entries.sortedBy { it.key as String } else entries
		out.append('{')
		for ((index, entry) in ordered.withIndex()) {
			if (index > 0) out.append(',')
			writeString(out, entry.key as String)
			out.append(':')
			writeValue(out, entry.value, canonical)
		}
		out.append('}')
	}

	private fun writeString(out: StringBuilder, value: String) {
		out.append('"')
		for (char in value) {
			when (char) {
				'"' -> out.append("\\\"")
				'\\' -> out.append("\\\\")
				'\b' -> out.append("\\b")
				'\u000c' -> out.append("\\f")
				'\n' -> out.append("\\n")
				'\r' -> out.append("\\r")
				'\t' -> out.append("\\t")
				else -> if (char < ' ') out.append("\\u%04x".format(char.code)) else out.append(char)
			}
		}
		out.append('"')
	}

	/**
	 * ECMAScript `Number::toString`（等价 JS 数字字面量格式，非 Java 的 `Double.toString`）。
	 * @param value 数字
	 * @return JS 风格字符串；NaN / 无穷为 `"null"`
	 */
	fun jsNumberToString(value: Double): String {
		if (value.isNaN() || value.isInfinite()) return "null"
		if (value == 0.0) return "0"
		val negative = value < 0
		val abs = if (negative) -value else value

		if (abs < 9_007_199_254_740_992.0 && abs % 1.0 == 0.0) {
			val digits = abs.toLong().toString()
			return if (negative) "-$digits" else digits
		}

		val decimal = BigDecimal(abs.toString()).stripTrailingZeros()
		val digitsStr = decimal.unscaledValue().abs().toString()
		val k = digitsStr.length
		val n = k - decimal.scale()

		val body = when {
			k <= n && n <= 21 -> digitsStr + "0".repeat(n - k)
			n in 1..21 -> digitsStr.substring(0, n) + "." + digitsStr.substring(n)
			n in -5..0 -> "0." + "0".repeat(-n) + digitsStr
			else -> {
				val head = digitsStr.substring(0, 1) + if (k > 1) "." + digitsStr.substring(1) else ""
				val exp = n - 1
				val expText = if (exp >= 0) "+$exp" else "$exp"
				"${head}e$expText"
			}
		}
		return if (negative) "-$body" else body
	}

	// ─── 值访问器 ─────────────────────────────────────────────────────────────

	/** @return `v` 为 String 时返回自身，否则 `null` */
	fun str(v: Any?): String? = v as? String

	/** @return `v` 为 Map 时返回自身，否则 `null` */
	fun obj(v: Any?): JsonObject? = v as? JsonObject

	/** @return `v` 为 List 时返回自身，否则 `null` */
	fun arr(v: Any?): JsonArray? = v as? JsonArray

	/** @return `v` 为 Boolean 时返回自身，否则 `null` */
	fun bool(v: Any?): Boolean? = v as? Boolean

	/** @return `v` 为数字时返回 Double，否则 `null` */
	fun num(v: Any?): Double? = (v as? Number)?.toDouble()

	/** @return `v` 为有限数字时返回 Long，否则 `null` */
	fun long(v: Any?): Long? {
		val d = num(v) ?: return null
		if (!d.isFinite()) return null
		return d.toLong()
	}

	/** @return `v` 为有限整数时返回 Int，否则 `null` */
	fun int(v: Any?): Int? = long(v)?.toInt()

	/** @return `v` 为有限数字时为 true */
	fun isFiniteNumber(v: Any?): Boolean = num(v)?.isFinite() == true

	/** @return 对象键 `key` 的值；`v` 非对象时为 `null` */
	fun at(v: Any?, key: String): Any? = (v as? Map<*, *>)?.get(key)

	/** 构造 JSON 对象（保持插入序）。 */
	fun jsonOf(vararg pairs: Pair<String, Any?>): JsonObject = linkedMapOf(*pairs)

	/** 构造可变 JSON 对象。 */
	fun mutableJsonOf(vararg pairs: Pair<String, Any?>): LinkedHashMap<String, Any?> = linkedMapOf(*pairs)
}
