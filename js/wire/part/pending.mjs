import { isPartInvokeResponse } from './invoke.mjs'

/** @typedef {import('./invoke.mjs').PartInvokeResponse} PartInvokeResponse */

/**
 * @typedef {{
 *   responses: PartInvokeResponse[]
 *   finish: () => void
 *   maxResponses: number
 *   respondedPeers: Set<string>
 * }} PendingPartInvoke
 */

/** @type {Map<string, PendingPartInvoke>} */
export const pendingPartInvoke = new Map()

/**
 * 入站 part_invoke_response：写入对应 pending 槽。
 * @param {object} payload 响应
 * @param {string} [peerId] 对端 id，用于同 peer 去重
 * @returns {void}
 */
export function handleIncomingPartInvokeResponse(payload, peerId = '') {
	const pending = pendingPartInvoke.get(payload.requestId)
	if (!pending || !isPartInvokeResponse(payload.response)) return
	if (peerId) {
		if (pending.respondedPeers.has(peerId)) return
		pending.respondedPeers.add(peerId)
	}
	pending.responses.push(payload.response)
	if (pending.responses.length >= pending.maxResponses) pending.finish()
}
