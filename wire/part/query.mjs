import {
	handleIncomingPartQueryResponse,
	processIncomingPartQueryRequest,
	queryNetwork as queryNetworkCore,
	resolvePartQueryState,
} from '../../federation/part_query/runtime.mjs'
import {
	parsePartQueryReq,
	parsePartQueryRes,
} from '../../schemas/part_query.mjs'
import partQueryTunables from '../../schemas/part_query.tunables.json' with { type: 'json' }
import { sendToNodeLink } from '../../transport/link_registry.mjs'
import { consumeWireRateBucket } from '../rate_bucket.mjs'
import { subscribeWire } from '../subscribe.mjs'

/** @typedef {import('../adapter.mjs').WireAdapter} WireAdapter */
/** @typedef {import('../adapter.mjs').WireContext} WireContext */
/** @typedef {import('../../federation/part_query/runtime.mjs').PartQueryDependencies} PartQueryDependencies */

/**
 * @param {PartQueryDependencies} [dependencies] 可注入依赖
 * @returns {PartQueryDependencies} 补上默认 deliver 后的依赖
 */
function withDefaultDeliver(dependencies = {}) {
	return {
		...dependencies,
		deliver: dependencies.deliver || ((nodeHash, action, payload) =>
			sendToNodeLink(nodeHash, { scope: 'node', action, payload })),
	}
}

/**
 * 挂载 part_query_req / part_query_res（入站 parse / dedupe / rate；运行时在 federation）。
 * @param {WireContext} wireContext 入站上下文
 * @param {WireAdapter} wire wire
 * @param {PartQueryDependencies} [dependencies] 可注入依赖（含 per-node state）
 * @returns {() => void} 取消挂载的 dispose
 */
export function attachPartQueryWire(wireContext, wire, dependencies = {}) {
	const deps = withDefaultDeliver(dependencies)
	const state = resolvePartQueryState(deps)
	return subscribeWire(wire, {
		/**
		 * @param {unknown} data part_query_req 载荷
		 * @param {string} peerId 对端 nodeHash
		 */
		part_query_req(data, peerId) {
			const request = parsePartQueryReq(data)
			if (!request) return
			if (!state.takeDedupe(request.requestId)) return
			const source = peerId || request.originNodeHash
			if (source && !consumeWireRateBucket(`part_query:${source}`, {
				maxCount: partQueryTunables.ratePerSourcePerMin,
			})) return
			void processIncomingPartQueryRequest(wireContext, wire, request, peerId, deps)
		},
		/**
		 * @param {unknown} data part_query_res 载荷
		 * @param {string} peerId 对端 nodeHash
		 */
		part_query_res(data, peerId) {
			const response = parsePartQueryRes(data)
			if (!response) return
			handleIncomingPartQueryResponse(response, peerId, deps)
		},
	})
}

/**
 * 多跳查询（默认经 link_registry 投递；可注入 deliver）。
 * @param {string} username trust graph 上下文
 * @param {string} partpath part 路径
 * @param {string} kind 查询标签
 * @param {unknown} query 不透明查询
 * @param {Parameters<typeof queryNetworkCore>[4]} [options] 选项
 * @returns {Promise<unknown[]>} 合并后的 rows
 */
export function queryNetwork(username, partpath, kind, query, options = {}) {
	return queryNetworkCore(username, partpath, kind, query, withDefaultDeliver(options))
}

/**
 * Part query 运行时（state、入站 handler、hop timeout、测试重置）。
 */
export {
	createPartQueryNodeState,
	registerQueryInboundHandler,
	resetPartQueryStateForTests,
	resolvePartQueryHopTimeoutMs,
	resolvePartQueryState,
} from '../../federation/part_query/runtime.mjs'
