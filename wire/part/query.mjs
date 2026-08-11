import { isPlainObject } from '../../core/object.mjs'
import {
	handleIncomingPartQueryResponse,
	processIncomingPartQueryRequest,
	resolvePartQueryState,
} from '../../federation/part_query/runtime.mjs'
import {
	parsePartQueryReq,
	parsePartQueryRes,
} from '../../schemas/part_query.mjs'
import partQueryTunables from '../../schemas/part_query.tunables.json' with { type: 'json' }
import { consumeWireRateBucket } from '../rate_bucket.mjs'

/** @typedef {import('./ingress.mjs').PartWireAdapter} PartWireAdapter */
/** @typedef {import('../../federation/part_query/runtime.mjs').PartQueryDependencies} PartQueryDependencies */

/**
 * 挂载 part_query_req / part_query_res（入站 parse / dedupe / rate；运行时在 federation）。
 * @param {{ replicaUsername?: string }} wireContext 入站上下文
 * @param {PartWireAdapter} wire wire
 * @param {PartQueryDependencies} [dependencies] 可注入依赖（含 per-node state）
 * @returns {() => void} 取消挂载的 dispose
 */
export function attachPartQueryWire(wireContext, wire, dependencies = {}) {
	const state = resolvePartQueryState(dependencies)
	const offs = [
		wire.on('part_query_req', (data, peerId) => {
			if (!isPlainObject(data)) return
			const request = parsePartQueryReq(data)
			if (!request) return
			if (!state.takeDedupe(request.requestId)) return
			const source = String(peerId || request.originNodeHash || '').trim().toLowerCase()
			if (source && !consumeWireRateBucket(`part_query:${source}`, {
				maxCount: partQueryTunables.ratePerSourcePerMin,
			})) return
			void processIncomingPartQueryRequest(wireContext, wire, request, String(peerId || ''), dependencies)
		}),
		wire.on('part_query_res', (data, peerId) => {
			const response = parsePartQueryRes(data)
			if (!response) return
			handleIncomingPartQueryResponse(response, String(peerId || ''), dependencies)
		}),
	]
	return () => {
		for (const off of offs)
			try { off?.() } catch { /* ignore */ }
	}
}
