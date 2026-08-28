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
 * 全局 miss 请求扇出：先向已知 peer 定向发送，再 trust-graph top-K fanout。
 * 已直连 / follow hint peer 可能不在 trust-graph top-K（非成员 emoji CAS / Social 预览路径），故先定向发送。
 * @param {string} username 用户
 * @param {string} action wire action 名
 * @param {object} payload 请求载荷
 * @param {string[]} [targets] 显式目标节点集（非 public manifest 的授权边界）；存在时只发目标集，不走 node-scope
 * @returns {Promise<void>}
 */
export async function fanoutFedFetch(username, action, payload, targets) {
	const tg = requireTrustGraphProvider(DEFAULT_TRUST_GRAPH_OWNER)
	if (targets?.length) {
		// 定向：只发显式目标集（非 public manifest 的授权边界）。
		// 依赖已有链路/群房间投递，不主动拨号——目标本就是已授权成员，无通道即不应服务。
		const graph = await tg.buildMergedGraph(username)
		for (const nodeHash of [...new Set(targets.filter(isHex64))])
			void tg.sendToNode(username, nodeHash, action, payload, graph)
		return
	}

	const graph = await tg.buildMergedGraph(username)
	const peerTargets = fetchPeerTargets()
	await Promise.all(peerTargets.map(nodeHash => ensureLinkToNode(nodeHash).catch(() => null)))
	for (const nodeHash of peerTargets)
		void tg.sendToNode(username, nodeHash, action, payload, graph)
	await tg.fanoutToTopNodes(username, action, payload, FEDERATION_CHUNK_FETCH_FANOUT_K)
}
