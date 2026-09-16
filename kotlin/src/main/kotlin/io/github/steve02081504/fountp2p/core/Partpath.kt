package io.github.steve02081504.fountp2p.core

private val PARTPATH_RE = Regex("^[\\w-]+(?:/[\\w-]+)*$")

/**
 * 入站 partpath 形校验（不改写）。仅用于非本机网络边界。
 * @param value 原始 partpath
 * @return 合法则原样返回；否则 null
 */
fun parsePartpath(value: Any?): String? {
	val text = value as? String ?: return null
	return if (PARTPATH_RE.matches(text)) text else null
}
