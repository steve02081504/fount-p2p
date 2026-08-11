/**
 * @param {unknown} value 待判定值
 * @returns {value is Record<string, unknown>} 是否为非 null 的普通对象（非数组）
 */
export function isPlainObject(value) {
	return value != null && !Array.isArray(value) && typeof value === 'object'
}
