package io.github.steve02081504.fountp2p.wire.part

import io.github.steve02081504.fountp2p.core.Json

/**
 * trust-graph part_invoke 扇出。
 *
 * 等价 `js/wire/part/fanout.mjs`。
 *
 * **未移植**：`collectPartInvokeResponses` 依赖尚未移植的
 * `node/identity.mjs`（`getNodeHash`）与 `trust_graph/registry.mjs`
 * （`requireTrustGraphProvider(...).fanoutToTopNodes`），待对应模块移植后补齐。
 */

/** 时间线 part_timeline_put fanout 上限。 */
const val TIMELINE_FANOUT_LIMIT = 8

/** part_invoke RPC collect 默认响应数。 */
const val PART_INVOKE_FANOUT_DEFAULT = 6

/**
 * @param results collect 原始结果
 * @return 仅含成功 result 的载荷
 */
fun partInvokeDataRows(results: List<Any?>): List<Any?> {
	val rows = mutableListOf<Any?>()
	for (row in results) {
		val data = unwrapPartInvokeResult(row)
		if (data != null) rows.add(data)
	}
	return rows
}

/**
 * @param results collect 原始结果
 * @return 邻居返回的错误信息
 */
fun partInvokeErrorMessages(results: List<Any?>): List<String> {
	val errors = mutableListOf<String>()
	for (row in results) {
		val message = Json.at(Json.at(row, "error"), "message")
		if (message is String && message.isNotEmpty()) errors.add(message)
	}
	return errors
}
