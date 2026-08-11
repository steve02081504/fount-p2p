import { isPlainObject } from '../../core/object.mjs'
import { parsePartpath } from '../../core/partpath.mjs'
import { dispatchDeliveryInbound, dispatchRpcInbound } from '../../registries/inbound.mjs'
import { subscribeWire } from '../subscribe.mjs'

import {
	isPartInvoke,
	isPartInvokeResponse,
	unwrapPartInvokeResult,
} from './invoke.mjs'
import { handleIncomingPartInvokeResponse } from './pending.mjs'

/** @typedef {import('../../wire/adapter.mjs').WireAdapter} WireAdapter */
/** @typedef {import('../../wire/adapter.mjs').WireContext} PartWireContext */
/** @typedef {import('./invoke.mjs').PartInvokeResponse} PartInvokeResponse */
/** @typedef {import('./invoke.mjs').PartInvoke} PartInvoke */

/**
 * @param {object} data 入站 part_timeline_put 载荷
 * @param {string} partpath 已校验 part 路径
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
 * @param {string} partpath part 路径
 * @param {PartInvoke} invoke 调用体
 * @param {string} [nodeHash] 来源节点
 * @param {string} [groupId] 群上下文
 * @returns {object} part_invoke 线载荷
 */
function buildPartInvokePayload(partpath, invoke, nodeHash, groupId) {
	return {
		partpath,
		invoke,
		...nodeHash ? { nodeHash } : {},
		...groupId ? { groupId } : {},
	}
}

/**
 * @param {PartWireContext} wireContext 入站上下文
 * @param {object} payload part_invoke 请求（含已验证 peerId）
 * @returns {Promise<PartInvokeResponse | null>} RPC 处理器返回值
 */
async function dispatchPartInvoke(wireContext, payload) {
	const partpath = parsePartpath(payload?.partpath)
	const invoke = payload?.invoke
	if (!partpath || !isPlainObject(invoke)) return null
	const requesterNodeHash = payload.peerId ? String(payload.peerId).trim() : null
	return dispatchRpcInbound({
		replicaUsername: wireContext.replicaUsername,
		requesterNodeHash,
		groupId: payload.groupId ? String(payload.groupId).trim() : undefined,
		peerId: payload.peerId,
	}, {
		type: 'part_invoke',
		partpath,
		invoke,
		groupId: payload.groupId,
		requestId: payload.requestId,
	})
}

/**
 * 挂载 part_timeline_put / part_invoke / part_invoke_response。
 * @param {PartWireContext} wireContext 入站上下文
 * @param {WireAdapter} wire action 表
 * @param {{ allowPartInvoke?: (payload: object) => boolean }} [options] 入站过滤
 * @returns {() => void} 取消挂载的 dispose
 */
export function attachPartWire(wireContext, wire, options = {}) {
	return subscribeWire(wire, {
		/**
		 * @param {unknown} data part_timeline_put 载荷
		 * @param {string} peerId 对端 nodeHash
		 */
		part_timeline_put(data, peerId) {
			if (!isPlainObject(data)) return
			const partpath = parsePartpath(data.partpath)
			if (!partpath) return
			const message = parsePartTimelinePut(data, partpath)
			if (!message) return
			void dispatchDeliveryInbound({
				replicaUsername: wireContext.replicaUsername,
				requesterNodeHash: peerId ? String(peerId).trim() : null,
			}, message)
		},
		/**
		 * @param {unknown} data part_invoke 载荷
		 * @param {string} peerId 对端 nodeHash
		 */
		part_invoke(data, peerId) {
			if (!isPlainObject(data)) return
			if (options.allowPartInvoke?.(data) === false) return
			const payload = { ...data, peerId }
			if (payload.requestId)
				void handleIncomingPartInvokeRequest(wireContext, payload, wire, peerId)
			else
				void handleIncomingPartInvokeFireAndForget(wireContext, payload, wire, peerId)
		},
		/**
		 * @param {unknown} data part_invoke_response 载荷
		 * @param {string} peerId 对端 nodeHash
		 */
		part_invoke_response(data, peerId) {
			if (!isPlainObject(data)) return
			handleIncomingPartInvokeResponse(data, peerId)
		},
	})
}

/**
 * @param {PartWireContext} wireContext 入站上下文
 * @param {object} payload part_invoke 请求（含 requestId）
 * @param {WireAdapter} wire 发送适配器
 * @param {string} peerId 对端
 * @returns {Promise<void>}
 */
export async function handleIncomingPartInvokeRequest(wireContext, payload, wire, peerId) {
	const partpath = parsePartpath(payload?.partpath)
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
 * @param {WireAdapter} wire 发送适配器
 * @param {string} peerId 对端
 * @returns {Promise<void>}
 */
export async function handleIncomingPartInvokeFireAndForget(wireContext, payload, wire, peerId) {
	const partpath = parsePartpath(payload?.partpath)
	if (!partpath) return

	const response = await dispatchPartInvoke(wireContext, { ...payload, peerId })
	const followUp = unwrapPartInvokeResult(response)
	if (!isPartInvoke(followUp)) return
	try {
		wire.send('part_invoke', buildPartInvokePayload(partpath, followUp, peerId, payload.groupId), peerId)
	}
	catch { /* disconnected */ }
}
