import { topologicalCanonicalOrder } from '../dag/index.mjs'
import { jsonlMutexKey, readJsonlEntries, writeJsonlLines } from '../dag/storage.mjs'
import { invalidateTopologicalOrderMemo } from '../federation/topo_order_memo.mjs'
import { descendantClosureFromTip } from '../governance/branch.mjs'
import { withAsyncMutex } from '../utils/async_mutex.mjs'

/**
 * 将 events.jsonl 裁剪为 checkpoint 起后代闭包（连通子图，非拓扑下标切片）。
 *
 * 整个读-算-写在 `jsonlMutexKey(eventsFilePath)` 锁内完成，避免与并发 append 竞态；
 * 写回的是保留行的原始字节（非 sanitize 后的重序列化），保持无损失。
 * @param {string} eventsFilePath events.jsonl 路径
 * @param {object | null} checkpoint 含 checkpoint_event_id 的快照
 * @param {(row: object) => object} [sanitize] 行规范化
 * @returns {Promise<{ pruned: boolean, kept: number, dropped: number }>} 裁剪统计
 */
export async function pruneEventsJsonlAfterCheckpoint(eventsFilePath, checkpoint, sanitize = row => row) {
	const tipId = checkpoint?.checkpoint_event_id
	if (!tipId) return { pruned: false, kept: 0, dropped: 0 }
	return withAsyncMutex(jsonlMutexKey(eventsFilePath), async () => {
		const entries = await readJsonlEntries(eventsFilePath, { sanitize })
		if (!entries.length) return { pruned: false, kept: 0, dropped: 0 }
		const byId = new Map(entries.map(entry => [entry.row.id, entry.row]))
		const rawById = new Map(entries.map(entry => [entry.row.id, entry.raw]))
		if (!byId.has(tipId)) return { pruned: false, kept: entries.length, dropped: 0 }

		const keepIds = descendantClosureFromTip(tipId, byId)
		const order = topologicalCanonicalOrder(entries.map(entry => ({
			id: entry.row.id,
			prev_event_ids: entry.row.prev_event_ids,
			hlc: entry.row.hlc,
			node_id: entry.row.node_id,
			sender: entry.row.sender,
		})))
		const keptIds = order.filter(id => keepIds.has(id))
		const dropped = entries.length - keptIds.length
		if (dropped <= 0) return { pruned: false, kept: keptIds.length, dropped: 0 }
		const keptRaws = keptIds.map(id => rawById.get(id)).filter(raw => raw !== undefined)
		await writeJsonlLines(eventsFilePath, keptRaws)
		invalidateTopologicalOrderMemo(eventsFilePath)
		return { pruned: true, kept: keptIds.length, dropped }
	})
}
