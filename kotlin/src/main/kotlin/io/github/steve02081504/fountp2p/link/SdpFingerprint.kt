package io.github.steve02081504.fountp2p.link

/**
 * 将 DTLS fingerprint 规范化为小写 `aa:bb:...` 格式。
 * @param value 原始 fingerprint 字符串
 * @return 规范化后的 fingerprint，无效时返回 null
 */
fun normalizeDtlsFingerprint(value: Any?): String? {
	val text = (value?.toString() ?: "")
		.trim()
		.lowercase()
		.replace(Regex("^sha-256\\s+"), "")
	if (text.isEmpty()) return null
	val compact = text.replace(Regex("\\s+"), "")
	if (!Regex("^([\\da-f]{2}:){31}[\\da-f]{2}$").matches(compact)) return null
	return compact
}

/**
 * 从 SDP 文本中提取 SHA-256 DTLS fingerprint。
 * @param sdp SDP 描述字符串
 * @return 规范化 fingerprint，未找到时返回 null
 */
fun extractDtlsFingerprint(sdp: String): String? {
	val line = Regex("^a=fingerprint:sha-256\\s+([\\d:A-Fa-f]+)$", RegexOption.MULTILINE)
		.find(sdp)?.groupValues?.get(1)
	return normalizeDtlsFingerprint(line)
}
