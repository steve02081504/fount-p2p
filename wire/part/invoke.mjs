import { isPlainObject } from '../../core/object.mjs'

/** @typedef {string} PartInvokeKind */

/**
 * @typedef {object & { kind: PartInvokeKind }} PartInvoke
 */

/** @typedef {{ message: string, code: string }} PartInvokeError */

/**
 * @typedef {object} PartInvokeResultResponse
 * @property {unknown} result
 */

/**
 * @typedef {object} PartInvokeErrorResponse
 * @property {PartInvokeError} error
 */

/** @typedef {PartInvokeResultResponse | PartInvokeErrorResponse} PartInvokeResponse */

/**
 * @param {unknown} value 候选响应
 * @returns {value is PartInvokeResponse} 是否为 part_invoke 响应体
 */
export function isPartInvokeResponse(value) {
	if (!isPlainObject(value)) return false
	const hasResult = Object.prototype.hasOwnProperty.call(value, 'result')
	const hasError = Object.prototype.hasOwnProperty.call(value, 'error')
	if (hasResult === hasError) return false
	if (hasError) {
		const err = value.error
		return isPlainObject(err)
			&& typeof err.message === 'string'
			&& typeof err.code === 'string'
			&& err.message.length
			&& err.code.length
	}
	return true
}

/**
 * @param {PartInvokeResponse | null | undefined} response RPC 响应
 * @returns {unknown | null} 成功 `result`；失败或空为 null
 */
export function unwrapPartInvokeResult(response) {
	if (!isPartInvokeResponse(response) || 'error' in response) return null
	return response.result ?? null
}

/**
 * @param {unknown} value invoke 体
 * @returns {value is PartInvoke} 是否含已知 kind
 */
export function isPartInvoke(value) {
	if (!isPlainObject(value)) return false
	const { kind } = value
	return typeof kind === 'string' && kind.length
}
