import { FEDERATION_CHUNK_FETCH_FANOUT_K } from '../core/constants.mjs'
import { isHex64 } from '../core/hexIds.mjs'
import { loadNetwork } from '../node/network.mjs'
import { ensureLinkToNode, listLinks } from '../transport/link_registry.mjs'
import { DEFAULT_TRUST_GRAPH_OWNER, requireTrustGraphProvider } from '../trust_graph/registry.mjs'

/**
 * @returns {string[]} 全局 miss 时应尝试拨号/发送的 nodeHash 列表
 */
function fetchPeerTargets() {
	/** @type {Set<string>} */
	const targets = new Set()
	for (const { nodeHash } of listLinks())
		if (nodeHash) targets.add(nodeHash)
	const net = loadNetwork()
	for (const nodeHash of [...net.trustedPeers || [], ...net.explorePeers || []])
		if (nodeHash) targets.add(nodeHash)
	for (const hint of net.hints || [])
		if (hint?.nodeHash) targets.add(hint.nodeHash)
	return [...targets]
}

/**
 * 规范化目标节点集：过滤非 64hex、去重（保持插入序）。fanout 与 manifest in-flight key 共用。
 * @param {string[]} [targets] 目标节点集
 * @returns {string[]} 规范化后的目标节点集
 */
export function canonicalizeFanoutTargets(targets) {
	return targets ? [...new Set(targets.filter(isHex64))] : []
}

/**
 * 全局 miss 请求扇出：先向已知 peer 定向发送，再 trust-graph top-K fanout。
 * 已直连 / follow hint peer 可能不在 trust-graph top-K（非成员 emoji CAS / Social 预览路径），故先定向发送。
 * 拨号不阻塞请求窗口：已直连 peer 立即经现有链路投递，未直连 peer 先经群房间/overlay 尝试并后台拨号补发。
 * @param {string} username 用户
 * @param {string} action wire action 名
 * @param {object} payload 请求载荷
 * @param {string[]} [fanoutTargets] 显式目标节点集（非 public manifest 的授权边界）；提供时（含空/全非法集）只发目标集，不走 node-scope
 * @returns {Promise<void>}
 */
export async function fanoutFedFetch(username, action, payload, fanoutTargets) {
	const trustGraph = requireTrustGraphProvider(DEFAULT_TRUST_GRAPH_OWNER)
	if (fanoutTargets !== undefined) {
		// 定向：只发显式目标集（非 public manifest 的授权边界）。
		// 空/全非法集也视为定向——调用方显式提供目标集即声明授权边界，不发 node-scope。
		// 依赖已有链路/群房间投递，不主动拨号——目标本就是已授权成员，无通道即不应服务。
		const graph = await trustGraph.buildMergedGraph(username)
		for (const nodeHash of canonicalizeFanoutTargets(fanoutTargets))
			void trustGraph.sendToNode(username, nodeHash, action, payload, graph)
		return
	}

	const graph = await trustGraph.buildMergedGraph(username)
	const peerTargets = fetchPeerTargets()
	// 已直连 peer 立即经现有链路投递；其余 peer 后台并行：先经群房间/overlay 尝试投递，同时拨号，拨通且首投失败再补发。
	// 全程不阻塞请求窗口（大 peer 池下 await 全量拨号会超窗口）。
	const linked = new Set(listLinks().map(({ nodeHash }) => nodeHash))
	for (const nodeHash of peerTargets) {
		if (linked.has(nodeHash)) {
			void trustGraph.sendToNode(username, nodeHash, action, payload, graph)
			continue
		}
		const dialed = ensureLinkToNode(nodeHash).catch(() => null)
		void trustGraph.sendToNode(username, nodeHash, action, payload, graph).then(async sent => {
			if (sent) return
			const link = await dialed
			if (link) await trustGraph.sendToNode(username, nodeHash, action, payload, graph)
		})
	}
	await trustGraph.fanoutToTopNodes(username, action, payload, FEDERATION_CHUNK_FETCH_FANOUT_K)
}
