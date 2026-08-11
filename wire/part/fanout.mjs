import { randomUUID } from 'node:crypto'

import { getNodeHash } from '../../node/identity.mjs'
import { DEFAULT_TRUST_GRAPH_OWNER, requireTrustGraphProvider } from '../../trust_graph/registry.mjs'

import { unwrapPartInvokeResult } from './invoke.mjs'
import { pendingPartInvoke } from './pending.mjs'

/** @typedef {import('./invoke.mjs').PartInvokeResponse} PartInvokeResponse */
/** @typedef {import('./invoke.mjs').PartInvoke} PartInvoke */

/** 时间线 part_timeline_put fanout 上限 */
export const TIMELINE_FANOUT_LIMIT = 8
/** part_invoke RPC collect 默认响应数 */
export const PART_INVOKE_FANOUT_DEFAULT = 6

/**
 * @param {string} partpath part 路径
 * @param {PartInvoke} invoke 调用体
 * @param {string} [nodeHash] 来源节点
 * @param {string} [requestId] RPC 请求 id
 * @returns {object} part_invoke 线载荷
 */
function buildPartInvokePayload(partpath, invoke, nodeHash, requestId) {
	return {
		partpath,
		invoke,
		...nodeHash ? { nodeHash } : {},
		...requestId ? { requestId } : {},
	}
}

/**
 * @param {PartInvokeResponse[]} results collect 原始结果
 * @returns {object[]} 仅含成功 result 的载荷
 */
export function partInvokeDataRows(results) {
	/** @type {object[]} */
	const rows = []
	for (const row of results) {
		const data = unwrapPartInvokeResult(row)
		if (data != null) rows.push(/** @type {object} */ data)
	}
	return rows
}

/**
 * @param {PartInvokeResponse[]} results collect 原始结果
 * @returns {string[]} 邻居返回的错误信息
 */
export function partInvokeErrorMessages(results) {
	/** @type {string[]} */
	const errors = []
	for (const row of results) {
		const message = row?.error?.message
		if (message) errors.push(message)
	}
	return errors
}

/**
 * 向 trust-graph top-K 扇出 part_invoke，收集 part_invoke_response。
 * 调用方须已挂载 `attachPartWire`（否则收不到 response）。
 * @param {string} username trust graph 上下文
 * @param {string} partpath part 路径
 * @param {PartInvoke} invoke 调用体
 * @param {number} [timeoutMs=2500] 超时
 * @param {number} [maxResponses=6] 最多响应数
 * @returns {Promise<PartInvokeResponse[]>} 邻居 PartInvokeResponse（含 error）
 */
export async function collectPartInvokeResponses(username, partpath, invoke, timeoutMs = 2500, maxResponses = PART_INVOKE_FANOUT_DEFAULT) {
	const requestId = randomUUID()
	const nodeHash = getNodeHash()
	/** @type {PartInvokeResponse[]} */
	const responses = []

	const waitForResponses = new Promise(resolve => {
		/**
		 *
		 */
		const finish = () => {
			clearTimeout(timer)
			pendingPartInvoke.delete(requestId)
			resolve(responses)
		}
		const timer = setTimeout(finish, timeoutMs)
		pendingPartInvoke.set(requestId, { responses, finish, maxResponses, respondedPeers: new Set() })
	})

	const sent = await requireTrustGraphProvider(DEFAULT_TRUST_GRAPH_OWNER).fanoutToTopNodes(
		username,
		'part_invoke',
		buildPartInvokePayload(partpath, invoke, nodeHash, requestId),
		maxResponses,
	)

	const pending = pendingPartInvoke.get(requestId)
	if (pending && sent === 0) pending.finish()

	return waitForResponses
}
