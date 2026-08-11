const PARTPATH_RE = /^[\w-]+(?:\/[\w-]+)*$/

/**
 * 入站 partpath 形校验（不改写）。仅用于非本机网络边界。
 * @param {unknown} value 原始 partpath
 * @returns {string | null} 合法则原样返回；否则 null
 */
export function parsePartpath(value) {
	return typeof value === 'string' && PARTPATH_RE.test(value) ? value : null
}
