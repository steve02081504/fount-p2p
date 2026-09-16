package io.github.steve02081504.fountp2p.core

/** 进程内 Map 复合键（`\0` 分隔）。 */
private const val COMPOSITE_KEY_SEP = "\u0000"

/**
 * @param parts 键段（至少一段）
 * @return 复合键
 */
fun compositeKey(vararg parts: String): String {
	if (parts.isEmpty()) throw IllegalArgumentException("compositeKey: at least one part required")
	return parts.joinToString(COMPOSITE_KEY_SEP)
}
