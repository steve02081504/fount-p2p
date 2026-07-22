import { strict as assert } from 'node:assert'

/**
 * 深度比较 actual 与 expected，不等则抛出 AssertionError。
 * @param {unknown} actual 实际值
 * @param {unknown} expected 期望值
 * @returns {void}
 */
export function assertEquals(actual, expected) {
	assert.deepEqual(actual, expected)
}

/**
 * 断言 thunk 执行时抛出异常；可选校验错误类型或消息。
 * @param {() => unknown} thunk 待测函数
 * @param {import('node:assert').AssertPredicate} [error] 期望的错误类型或匹配谓词
 * @returns {void}
 */
export function assertThrows(thunk, error) {
	if (error) assert.throws(thunk, error)
	else assert.throws(thunk)
}

/**
 *
 */
export { assert }
