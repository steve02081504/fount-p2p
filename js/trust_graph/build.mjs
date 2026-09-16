import { isPeerKeyBlocked, isSubjectBlocked } from '../node/denylist.mjs'
import { loadNetwork } from '../node/network.mjs'
import { loadReputation } from '../node/reputation_store.mjs'
import { listFederationRoomSlots } from '../registries/room_provider.mjs'
import { isQuarantinedPure } from '../reputation/engine.mjs'

import { getCachedTrustGraph } from './cache.mjs'
import { mergeGraph, pickTopFromGraph } from './engine.mjs'
import trustGraphTunables from './tunables.json' with { type: 'json' }

/**
 * @typedef {import('./engine.mjs').TrustNode} TrustNode
 */

/**
 * @param {string} nodeHash 64 位十六进制
 * @returns {boolean} 是否拉黑
 */
function isNodeBlocked(nodeHash) {
	return isPeerKeyBlocked('', nodeHash) || isSubjectBlocked({ nodeHash })
}

/**
 * @param {string} username 副本用户名 登录名（联邦房间枚举仍按用户）
 * @returns {Promise<Map<string, TrustNode>>} nodeHash → 节点
 */
export async function buildMergedGraph(username) {
	return getCachedTrustGraph(username, async () => {
		const net = loadNetwork()
		const rep = loadReputation()
		const blocked = new Set()
		const quarantined = new Set()
		for (const nodeHash of [...net.trustedPeers, ...net.explorePeers, ...net.hints.map(h => h.nodeHash)]) {
			if (isNodeBlocked(nodeHash)) blocked.add(nodeHash)
			if (isQuarantinedPure(rep, nodeHash)) quarantined.add(nodeHash)
		}

		/**
		 * @param {string} nodeHash 64 位十六进制
		 * @returns {number} 信誉分
		 */
		function scoreOf(nodeHash) {
			return Number(rep.byNodeHash?.[nodeHash]?.score ?? 0)
		}

		const rooms = await listFederationRoomSlots(username)
		/** @type {import('./engine.mjs').TrustGraphInputs['roomRosters']} */
		const roomRosters = []
		for (const room of rooms) {
			const nodeHashes = []
			for (const { remoteNodeHash } of room.getRoster()) {
				if (!remoteNodeHash) continue
				if (isNodeBlocked(remoteNodeHash)) blocked.add(remoteNodeHash)
				else if (isQuarantinedPure(rep, remoteNodeHash)) quarantined.add(remoteNodeHash)
				else nodeHashes.push(remoteNodeHash)
			}
			/**
			 * @param {string} remoteNodeHash 64 位十六进制
			 * @returns {number} 本地主观信誉分；从未打分的新人退回 rosterDefaultScore
			 */
			function rosterScoreOf(remoteNodeHash) {
				const row = rep.byNodeHash?.[remoteNodeHash]
				return row && Number.isFinite(Number(row.score))
					? Number(row.score)
					: trustGraphTunables.rosterDefaultScore
			}
			roomRosters.push({
				scopeId: room.groupId,
				nodeHashes,
				scoreOf: rosterScoreOf,
			})
		}

		return mergeGraph({
			trustedPeers: net.trustedPeers,
			explorePeers: net.explorePeers,
			hints: net.hints,
			roomRosters,
			blockedNodeHashes: blocked,
			quarantinedNodeHashes: quarantined,
			scoreOf,
		})
	})
}

/**
 * @param {string} username 副本用户名 登录名
 * @param {number} [limit=12] 最多返回节点数
 * @returns {Promise<TrustNode[]>} 按信誉降序
 */
export async function pickTopNodes(username, limit = trustGraphTunables.pickTopNodesDefaultLimit) {
	const rep = loadReputation()
	const quarantined = new Set(
		Object.keys(rep.byNodeHash || {}).filter(id => isQuarantinedPure(rep, id)),
	)
	return pickTopFromGraph(await buildMergedGraph(username), limit, trustGraphTunables, quarantined)
}
