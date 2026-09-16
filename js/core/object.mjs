/**
 * 判定 `{}` 形态对象（原型为 Object.prototype）。
 * 数组、Date/Map/类实例、null 原型对象一律否。
 * @param {unknown} value 待判定值
 * @returns {value is Record<string, unknown>} 是否为普通对象
 */
export function isPlainObject(value) {
	return value != null && Object.getPrototypeOf(value) === Object.prototype
}
