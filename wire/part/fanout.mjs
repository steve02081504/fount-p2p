import { randomUUID } from 'node:crypto'

import { getNodeHash } from '../../node/identity.mjs'
import { DEFAULT_TRUST_GRAPH_OWNER, requireTrustGraphProvider } from '../../trust_graph/registry.mjs'

import {
	buildPartInvokePayload,
	PART_INVOKE_FANOUT_DEFAULT,
} from './common.mjs'
import { pendingPartInvoke } from './ingress.mjs'

/** @typedef {import('./invoke.mjs').PartInvokeResponse} PartInvokeResponse */

/**
 * @param {string} username 用户（trust graph fanout 上下文）
 * @param {string} partpath part 路径
 * @param {import('./invoke.mjs').PartInvoke} invoke 调用体
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
		 * 超时或收齐响应后结束等待并清理 pending part_invoke。
		 */
		const finish = () => {
			clearTimeout(timer)
			pendingPartInvoke.delete(requestId)
			resolve(responses)
		}
		const timer = setTimeout(finish, timeoutMs)
		pendingPartInvoke.set(requestId, { responses, finish, maxResponses, respondedPeers: new Set() })
	})

	const sent = await requireTrustGraphProvider(DEFAULT_TRUST_GRAPH_OWNER).fanoutToTopNodes(username, 'part_invoke', buildPartInvokePayload({
		partpath,
		invoke,
		nodeHash,
		requestId,
	}), maxResponses)

	const pending = pendingPartInvoke.get(requestId)
	if (pending && sent === 0) pending.finish()

	return waitForResponses
}
