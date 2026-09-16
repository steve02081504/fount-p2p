package io.github.steve02081504.fountp2p.dag

import io.github.steve02081504.fountp2p.core.JsonUndefined
import io.github.steve02081504.fountp2p.core.assertHex64
import io.github.steve02081504.fountp2p.core.isEntityHash128

/**
 * DAG / 时间线签名行入库前的共用 hex 规范化（非权限校验）。
 */

/** JS 真值语义（`!value` 的补）。 */
internal fun jsonTruthy(value: Any?): Boolean = when (value) {
	null, JsonUndefined -> false
	is Boolean -> value
	is Number -> {
		val d = value.toDouble()
		d != 0.0 && !d.isNaN()
	}
	is String -> value.isNotEmpty()
	else -> true
}

/**
 * @param obj 可变对象
 * @param key 字段名
 */
private fun canonicalizeHexField(obj: MutableMap<String, Any?>, key: String) {
	if (!jsonTruthy(obj[key])) return
	obj[key] = assertHex64(obj[key], key)
}

/**
 * @param content 事件 content
 * @param hexKeys content 内 hex64 字段名
 * @param entityHashKeys content 内 128 位 entityHash 字段名
 * @return 规范化后的 content
 */
fun canonicalizeRowContent(
	content: Any?,
	hexKeys: Set<String>,
	entityHashKeys: Set<String> = emptySet(),
): Any? {
	if (!jsonTruthy(content)) return content
	val source = content as? Map<*, *> ?: return content
	val out = LinkedHashMap<String, Any?>()
	for ((key, value) in source) if (key is String) out[key] = value
	for (key in hexKeys) canonicalizeHexField(out, key)
	for (key in entityHashKeys) {
		if (!jsonTruthy(out[key])) continue
		val entityHash = isEntityHash128(out[key])
			?: throw IllegalArgumentException("$key must be 128 hex characters")
		out[key] = entityHash
	}
	if (jsonTruthy(out["content_ref"])) {
		val refSource = out["content_ref"] as? Map<*, *>
		if (refSource != null) {
			val ref = LinkedHashMap<String, Any?>()
			for ((key, value) in refSource) if (key is String) ref[key] = value
			canonicalizeHexField(ref, "contentHash")
			out["content_ref"] = ref
		}
	}
	return out
}

/**
 * `canonicalizeSignedRow` 的各域字段集。
 * @param prepare 事件预处理
 * @param contentHexKeys content 内 hex64 字段名
 * @param entityHashKeys content 内 128 位 entityHash 字段名
 */
class SignedRowOptions(
	val prepare: ((Map<String, Any?>) -> Map<String, Any?>)? = null,
	val contentHexKeys: Set<String>? = null,
	val entityHashKeys: Set<String> = emptySet(),
)

/**
 * @param event 签名事件
 * @param options 各域字段集
 * @return canonical 行
 */
fun canonicalizeSignedRow(
	event: Map<String, Any?>,
	options: SignedRowOptions = SignedRowOptions(),
): Map<String, Any?> {
	val out: MutableMap<String, Any?> = if (options.prepare != null)
		LinkedHashMap(options.prepare.invoke(LinkedHashMap(event)))
	else
		LinkedHashMap(event)
	out["id"] = assertHex64(out["id"], "id")
	out["sender"] = assertHex64(out["sender"], "sender")
	val prev = out["prev_event_ids"]
	if (jsonTruthy(prev)) {
		val list = prev as? List<*> ?: emptyList<Any?>()
		out["prev_event_ids"] = list.mapIndexed { index, id -> assertHex64(id, "prev_event_ids[$index]") }
	}
	val hexKeys = options.contentHexKeys
	if (jsonTruthy(out["content"]) && !hexKeys.isNullOrEmpty())
		out["content"] = canonicalizeRowContent(out["content"], hexKeys, options.entityHashKeys)
	return out
}
