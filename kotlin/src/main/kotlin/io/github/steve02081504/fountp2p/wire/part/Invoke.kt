package io.github.steve02081504.fountp2p.wire.part

import io.github.steve02081504.fountp2p.core.isPlainObject

/**
 * part_invoke 响应体与调用体的验形工具。
 *
 * 等价 `js/wire/part/invoke.mjs`。
 */

/**
 * @param value 候选响应
 * @return 是否为 part_invoke 响应体
 */
fun isPartInvokeResponse(value: Any?): Boolean {
	if (!isPlainObject(value)) return false
	val response = value as Map<*, *>
	val hasResult = response.containsKey("result")
	val hasError = response.containsKey("error")
	if (hasResult == hasError) return false
	if (hasError) {
		val error = response["error"]
		if (!isPlainObject(error)) return false
		val errorMap = error as Map<*, *>
		val message = errorMap["message"]
		val code = errorMap["code"]
		return message is String && message.isNotEmpty() && code is String && code.isNotEmpty()
	}
	return true
}

/**
 * @param response RPC 响应
 * @return 成功 `result`；失败或空为 null
 */
fun unwrapPartInvokeResult(response: Any?): Any? {
	if (!isPartInvokeResponse(response) || (response as Map<*, *>).containsKey("error")) return null
	return (response as Map<*, *>)["result"] ?: null
}

/**
 * @param value invoke 体
 * @return 是否含已知 kind
 */
fun isPartInvoke(value: Any?): Boolean {
	if (!isPlainObject(value)) return false
	val kind = (value as Map<*, *>)["kind"]
	return kind is String && kind.isNotEmpty()
}
