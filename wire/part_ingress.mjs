
import { dispatchDeliveryInbound, dispatchRpcInbound } from '../registries/inbound.mjs'

import { isPlainObject } from './ingress.mjs'
import { buildPartInvokePayload } from './part_common.mjs'
import {
	isPartInvoke,
	isPartInvokeResponse,
	normalizePartpath,
	unwrapPartInvokeResult,
} from './part_invoke.mjs'

/** @typedef {import('./part_invoke.mjs').PartInvokeResponse} PartInvokeResponse */

/** @type {Map<string, { responses: PartInvokeResponse[], finish: () => void, maxResponses: number, respondedPeers: Set<string> }>} */
export const pendingPartInvoke = new Map()

/**
 * @typedef {{
 *   send: (name: string, payload: unknown, peerId: string | null) => void
 *   on: (name: string, handler: (payload: unknown, peerId: string) => void) => void
 * }} PartWireAdapter
 */

/**
 * @typedef {{ replicaUsername?: string }} PartWireContext
 */

/**
 * @param {object} data 入站 part_timeline_put 载荷
 * @param {string} partpath 已规范化 part 路径
 * @returns {object | null} 白名单字段
 */
function parsePartTimelinePut(data, partpath) {
	const timelineEntityHash = String(data.timelineEntityHash || '').trim().toLowerCase()
	if (!timelineEntityHash || !isPlainObject(data.event)) return null
	return {
		type: 'part_timeline_put',
		partpath,
		timelineEntityHash,
		event: data.event,
		...data.nodeHash ? { nodeHash: String(data.nodeHash).trim() } : {},
		...data.groupId ? { groupId: String(data.groupId).trim() } : {},
	}
}

/**
 * @param {PartWireContext} wireContext 入站上下文
 * @param {object} payload part_invoke 请求
 * @returns {Promise<PartInvokeResponse | null>} RPC 处理器返回值
 */
async function dispatchPartInvoke(wireContext, payload) {
	const partpath = normalizePartpath(payload?.partpath)
	const invoke = payload?.invoke
	if (!partpath || !isPlainObject(invoke)) return null
	return dispatchRpcInbound({
		replicaUsername: wireContext.replicaUsername,
		requesterNodeHash: payload.nodeHash ? String(payload.nodeHash).trim() : null,
		groupId: payload.groupId ? String(payload.groupId).trim() : undefined,
		peerId: payload.peerId,
	}, {
		type: 'part_invoke',
		partpath,
		invoke,
		nodeHash: payload.nodeHash,
		groupId: payload.groupId,
		requestId: payload.requestId,
	})
}

/**
 * 挂载 part_timeline_put / part_invoke / part_invoke_response。
 * @param {PartWireContext} wireContext 入站上下文
 * @param {PartWireAdapter} wire Trystero 适配器
 * @param {{ allowPartInvoke?: (payload: object) => boolean }} [options] 入站过滤
 * @returns {void}
 */
export function attachPartWire(wireContext, wire, options = {}) {
	wire.on('part_timeline_put', data => {
		if (!isPlainObject(data)) return
		const partpath = normalizePartpath(data.partpath)
		if (!partpath) return
		const message = parsePartTimelinePut(data, partpath)
		if (!message) return
		void dispatchDeliveryInbound({
			replicaUsername: wireContext.replicaUsername,
			requesterNodeHash: data.nodeHash ? String(data.nodeHash).trim() : null,
		}, message)
	})

	wire.on('part_invoke', (data, peerId) => {
		if (!isPlainObject(data)) return
		if (options.allowPartInvoke?.(data) === false) return
		const payload = { ...data, peerId }
		if (payload.requestId)
			void handleIncomingPartInvokeRequest(wireContext, payload, wire, peerId)
		else
			void handleIncomingPartInvokeFireAndForget(wireContext, payload, wire, peerId)
	})

	wire.on('part_invoke_response', (data, peerId) => {
		if (!isPlainObject(data)) return
		handleIncomingPartInvokeResponse(data, peerId)
	})
}

/**
 * @param {PartWireContext} wireContext 入站上下文
 * @param {object} payload part_invoke 请求（含 requestId）
 * @param {PartWireAdapter} wire 发送适配器
 * @param {string} peerId 对端
 * @returns {Promise<void>}
 */
export async function handleIncomingPartInvokeRequest(wireContext, payload, wire, peerId) {
	const partpath = normalizePartpath(payload?.partpath)
	if (!partpath || !payload.requestId) return

	const response = await dispatchPartInvoke(wireContext, { ...payload, peerId })
	if (!isPartInvokeResponse(response)) return

	try {
		wire.send('part_invoke_response', {
			requestId: payload.requestId,
			partpath,
			response,
		}, peerId)
	}
	catch { /* disconnected */ }
}

/**
 * @param {PartWireContext} wireContext 入站上下文
 * @param {object} payload part_invoke 请求（无 requestId）
 * @param {PartWireAdapter} wire 发送适配器
 * @param {string} peerId 对端
 * @returns {Promise<void>}
 */
export async function handleIncomingPartInvokeFireAndForget(wireContext, payload, wire, peerId) {
	const partpath = normalizePartpath(payload?.partpath)
	if (!partpath) return

	const response = await dispatchPartInvoke(wireContext, { ...payload, peerId })
	const followUp = unwrapPartInvokeResult(response)
	if (!isPartInvoke(followUp)) return
	try {
		wire.send('part_invoke', buildPartInvokePayload({
			partpath,
			invoke: followUp,
			nodeHash: payload.nodeHash,
			groupId: payload.groupId,
		}), peerId)
	}
	catch { /* disconnected */ }
}

/**
 * @param {object} payload 响应
 * @param {string} [peerId] Trystero 对端 id，用于同 peer 去重
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
