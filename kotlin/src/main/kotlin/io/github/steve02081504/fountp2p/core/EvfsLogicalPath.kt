package io.github.steve02081504.fountp2p.core

/**
 * @param logicalPath EVFS 逻辑路径
 * @return 规范化后的相对路径
 */
fun assertSafeEvfsLogicalPath(logicalPath: String?): String {
	if (logicalPath.isNullOrEmpty() || logicalPath.contains('\u0000'))
		throw IllegalArgumentException("invalid EVFS path")
	val segments = logicalPath.split(Regex("[/\\\\]+")).filter { it.isNotEmpty() }
	if (segments.isEmpty()) throw IllegalArgumentException("invalid EVFS path")
	for (segment in segments)
		if (segment == "." || segment == "..")
			throw IllegalArgumentException("invalid EVFS path traversal")
	return segments.joinToString("/")
}
