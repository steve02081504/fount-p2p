package io.github.steve02081504.fountp2p.core

/** 64 位小写十六进制（DAG 事件 id、公钥哈希等）。 */
val HEX_ID_64 = Regex("^[\\da-f]{64}$")

/** 签名 hex（128 字符）。 */
val SIGNATURE_HEX_128 = Regex("^[\\da-f]{128}$")

/** `blob:<64hex>` 存储定位符。 */
val BLOB_STORAGE_LOCATOR_RE = Regex("^blob:([\\da-f]{64})$")

/** `local:…/chunks/<64hex>.bin` 群分块路径。 */
val LOCAL_CHUNK_FILE_RE = Regex("^local:[^/]+/chunks/([\\da-f]{64})\\.bin$")

/**
 * @param value 待校验值
 * @return 合法时返回原 64 位 hex，否则 null（含 0x 前缀/大写/空白）
 */
fun isHex64(value: Any?): String? {
	val text = value as? String ?: return null
	return if (HEX_ID_64.matches(text)) text else null
}

/**
 * 64 位 hex eventId 字典序比较（固定宽度 ASCII，不用 localeCompare）。
 * @param a 左操作数
 * @param b 右操作数
 * @return 排序比较结果
 */
fun compareHex64Asc(a: String, b: String): Int = a.compareTo(b)

/**
 * 外部入站专用：断言小写 64 位 hex（不清理 0x 前缀，直接拒绝）。
 * @param value 原始值
 * @param label 字段名（错误信息）
 * @return 小写 64 位 hex
 */
fun assertHex64(value: Any?, label: String = "hex64"): String {
	val text = value as? String
	if (text == null || !HEX_ID_64.matches(text))
		throw IllegalArgumentException("$label must be 64 hex characters")
	return text
}

/**
 * @param value 待校验值
 * @return 合法时返回 128 位签名 hex，否则 null
 */
fun isSignatureHex128(value: Any?): String? {
	val normalized = value?.toString() ?: ""
	return if (SIGNATURE_HEX_128.matches(normalized)) normalized else null
}
