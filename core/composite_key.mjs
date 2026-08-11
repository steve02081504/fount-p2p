/** 进程内 Map 复合键（`\0` 分隔；V8 对短 ConsString 拼接很快）。 */

const SEP = '\0'

/**
 * @param {...string} parts 键段（至少一段）
 * @returns {string} 复合键
 */
export function compositeKey(...parts) {
	if (!parts.length) throw new Error('compositeKey: at least one part required')
	return parts.join(SEP)
}
