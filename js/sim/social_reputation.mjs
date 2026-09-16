/**
 * Social follow-block 信誉信号（仿真用纯函数；生产逻辑在 social shell）。
 * @param {import('../node/reputation_store.mjs').ReputationFile} reputation 节点信誉文件
 * @param {{ followerNodeHash: string, targetNodeHash: string, voterKey: string, action: 'block' | 'unblock', selfTrust?: boolean }} signal follow-block 信号
 * @param {number} now 当前时间戳（毫秒）
 * @param {{ followedBlockSelfTrustPenalty?: number, followedBlockPenalty?: number }} tunables 惩罚系数
 * @returns {void}
 */
export function applyFollowedBlockSignalPure(reputation, signal, now, tunables = {}) {
	const { targetNodeHash, voterKey, action, selfTrust = false } = signal
	if (!targetNodeHash || !voterKey) return
	if (!reputation.byNodeHash[targetNodeHash])
		reputation.byNodeHash[targetNodeHash] = { score: 0 }
	const row = reputation.byNodeHash[targetNodeHash]
	if (!row.blockPenalties) row.blockPenalties = {}
	if (action === 'block') {
		if (row.blockPenalties[voterKey]) return
		const penalty = selfTrust
			? tunables.followedBlockSelfTrustPenalty ?? 0.12
			: tunables.followedBlockPenalty ?? 0.06
		row.score = (row.score ?? 0) - penalty
		row.blockPenalties[voterKey] = { penalty, at: now }
	}
	else if (action === 'unblock') {
		const entry = row.blockPenalties[voterKey]
		if (!entry) return
		row.score = (row.score ?? 0) + entry.penalty
		delete row.blockPenalties[voterKey]
	}
}
