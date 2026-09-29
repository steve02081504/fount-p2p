import { topologicalCanonicalOrder } from '../dag/index.mjs'
import { jsonlMutexKey, readJsonlEntries, writeJsonlLines } from '../dag/storage.mjs'
import { invalidateTopologicalOrderMemo } from '../federation/topo_order_memo.mjs'
import { computeDagTipIdsFromEvents, selectConsensusBranchTip } from '../governance/branch.mjs'
import { computeRetentionKeepIds } from '../node/retention_policy.mjs'
import { withAsyncMutex } from '../utils/async_mutex.mjs'

/**
 * 整个读-算-写在 `jsonlMutexKey(eventsFilePath)` 锁内完成，避免与并发 append 竞态；
 * 写回的是保留行的原始字节（非 sanitize 后的重序列化），保持无损失。
 * @param {string} eventsFilePath events.jsonl 路径
 * @param {object | null} checkpointHint 检查点提示
 * @param {{ maxDepth: number, maxMs: number, anchorTypes: Set<string> }} policy 保留策略
 * @param {(row: object) => object} sanitize 行规范化
 * @returns {Promise<{ pruned: boolean, kept: number, dropped: number }>} 裁剪统计
 */
export async function enforceTimelineEventRetention(
	eventsFilePath,
	checkpointHint,
	policy,
	sanitize = row => row,
) {
	return withAsyncMutex(jsonlMutexKey(eventsFilePath), async () => {
		const entries = await readJsonlEntries(eventsFilePath, { sanitize })
		if (!entries.length) return { pruned: false, kept: 0, dropped: 0 }
		const maxDepth = Math.max(256, Number(policy.maxDepth) || 200_000)
		const maxMs = Math.max(3_600_000, Number(policy.maxMs) || 365 * 24 * 3600 * 1000)
		const cutoffWall = Date.now() - maxMs
		const events = entries.map(entry => entry.row)
		const rawById = new Map(entries.map(entry => [entry.row.id, entry.raw]))
		const byId = new Map(events.map(e => [e.id, e]))
		const order = topologicalCanonicalOrder(events.map(e => ({
			id: e.id,
			prev_event_ids: e.prev_event_ids,
			hlc: e.hlc,
			node_id: e.node_id,
			sender: e.sender,
		})))
		const tips = computeDagTipIdsFromEvents(events)
		const branchTipId = selectConsensusBranchTip(tips, byId)
		const checkpointTipId = checkpointHint?.checkpoint_event_id || null
		const keepIds = computeRetentionKeepIds(order, byId, {
			maxDepth,
			cutoffWall,
			anchorTypes: policy.anchorTypes,
			checkpointTipId,
			branchTipId,
		})
		if (keepIds.size >= events.length) return { pruned: false, kept: events.length, dropped: 0 }
		const keptIds = order.filter(id => keepIds.has(id))
		const dropped = events.length - keptIds.length
		if (dropped <= 0) return { pruned: false, kept: keptIds.length, dropped: 0 }
		const keptRaws = keptIds.map(id => rawById.get(id)).filter(raw => raw !== undefined)
		await writeJsonlLines(eventsFilePath, keptRaws)
		invalidateTopologicalOrderMemo(eventsFilePath)
		return { pruned: true, kept: keptIds.length, dropped }
	})
}
