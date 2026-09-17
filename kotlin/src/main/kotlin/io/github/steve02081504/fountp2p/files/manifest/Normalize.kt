package io.github.steve02081504.fountp2p.files.manifest

import io.github.steve02081504.fountp2p.core.JsonUndefined
import io.github.steve02081504.fountp2p.core.isEntityHash128
import io.github.steve02081504.fountp2p.core.isHex64
import io.github.steve02081504.fountp2p.federation.jsTruthy
import io.github.steve02081504.fountp2p.files.jsNumberOr
import io.github.steve02081504.fountp2p.files.jsStringOr

/**
 * File manifest 校验与规范化（等价 `files/manifest/normalize.mjs`）。
 */

/** 合法 ceMode 集合。 */
private val CE_MODES = setOf("plain", "convergent", "random")

/** 合法 transferKeyDescriptor.type 集合。 */
private val TRANSFER_TYPES = setOf("public", "file-master-key-wrap", "vault-wrap", "identity-wrap")

/**
 * @param value 任意 JSON 值
 * @return 值为 JSON 对象（Map）时为真
 */
private fun isJsonObject(value: Any?): Boolean = value is Map<*, *>

/** @return 转义 `\` 为 `/` 并去掉前导 `/` */
private fun normalizeLogicalPath(value: Any?): String =
	jsStringOr(value, "").replace(Regex("^/+"), "").replace("\\", "/")

/**
 * @param input 原始对象
 * @return 校验后的 manifest；非法为 null
 */
fun normalizeFileManifest(input: Any?): Map<String, Any?>? {
	if (!isJsonObject(input)) return null
	val map = input as Map<*, *>
	val ownerEntityHash = isEntityHash128(map["ownerEntityHash"]) ?: return null
	val logicalPath = normalizeLogicalPath(map["logicalPath"])
	if (logicalPath.isEmpty()) return null
	val ceMode = jsStringOr(map["ceMode"], "convergent")
	if (ceMode !in CE_MODES) return null

	val rawParts = map["parts"] as? List<*> ?: emptyList<Any?>()
	val parts = ArrayList<Map<String, Any?>>()
	for (rawPart in rawParts) {
		val part = rawPart as? Map<*, *>
		val out = LinkedHashMap<String, Any?>()
		out["hash"] = jsStringOr(part?.get("hash"), "")
		out["size"] = jsNumberOr(part?.get("size"), 0.0)
		val partContentHash = jsStringOr(part?.get("contentHash"), "")
		if (isHex64(partContentHash) != null) out["contentHash"] = partContentHash
		if (isHex64(out["hash"]) != null) parts.add(out)
	}
	if (parts.isEmpty()) return null

	val transferKeyDescriptor = normalizeTransferKeyDescriptor(map["transferKeyDescriptor"]) ?: return null

	val manifestMeta = map["meta"]
	val out = LinkedHashMap<String, Any?>()
	out["ownerEntityHash"] = ownerEntityHash
	out["logicalPath"] = logicalPath
	out["name"] = jsStringOr(map["name"], logicalPath.substringAfterLast('/').ifEmpty { "file" })
	out["mimeType"] = jsStringOr(map["mimeType"], "application/octet-stream")
	out["size"] = jsNumberOr(map["size"], 0.0)
	out["contentHash"] = jsStringOr(map["contentHash"], "")
	out["ceMode"] = ceMode
	out["parts"] = parts
	out["transferKeyDescriptor"] = transferKeyDescriptor
	if (isJsonObject(manifestMeta)) {
		val copied = LinkedHashMap<String, Any?>()
		for ((key, value) in manifestMeta as Map<*, *>) if (key is String) copied[key] = value
		out["meta"] = copied
	}
	// JS 中 meta 为 undefined 时该键存在但序列化跳过；Kotlin 用 JsonUndefined 等价表示。
	else out["meta"] = JsonUndefined
	return out
}

/**
 * @param input 描述符
 * @return 校验后的传输密钥描述符；非法为 null
 */
fun normalizeTransferKeyDescriptor(input: Any?): Map<String, Any?>? {
	if (!isJsonObject(input)) return null
	val map = input as Map<*, *>
	val type = jsStringOr(map["type"], "")
	if (type !in TRANSFER_TYPES) return null
	val out = LinkedHashMap<String, Any?>()
	out["type"] = type
	val wrappedKey = map["wrappedKey"]
	if (isJsonObject(wrappedKey)) {
		val wrapped = wrappedKey as Map<*, *>
		val copied = LinkedHashMap<String, Any?>()
		copied["iv"] = jsStringOr(wrapped["iv"], "")
		copied["ciphertext"] = jsStringOr(wrapped["ciphertext"], "")
		copied["authTag"] = jsStringOr(wrapped["authTag"], "")
		out["wrappedKey"] = copied
	}
	if (jsTruthy(map["groupId"])) out["groupId"] = jsStringOr(map["groupId"], "")
	if (jsTruthy(map["fileId"])) out["fileId"] = jsStringOr(map["fileId"], "")
	if (jsTruthy(map["entityHash"])) out["entityHash"] = jsStringOr(map["entityHash"], "")
	if (map["keyGeneration"] != null) out["keyGeneration"] = jsNumberOr(map["keyGeneration"], 0.0)
	return out
}

/** @return public 描述符 */
fun publicTransferKeyDescriptor(): Map<String, Any?> = linkedMapOf("type" to "public")
