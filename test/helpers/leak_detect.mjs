import process from 'node:process'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'

/**
 * 触发一次垃圾回收。
 * @returns {void}
 */
export function gc() {
	setFlagsFromString('--expose_gc')
	runInNewContext('gc')({
		execution: 'sync',
		flavor: 'last-resort',
		type: 'major'
	})
}

/**
 * 快照当前活跃资源的类型 → 计数。
 *
 * 活跃资源列出当前仍存活的所有句柄/连接（Tcp/TLSSocket/WebSocket/HTTPClientRequest/定时器等）。
 * 传输层“打开连接但忘记关闭”会让对应类型的计数随操作次数线性增长，因此可用它做不绑定具体
 * 传输（nostr / BT / LAN…）的通用泄漏探测。
 * @returns {Map<string, number>} 资源类型 → 计数
 */
export function snapshotActiveResources() {
	const counts = new Map()
	for (const type of process.getActiveResourcesInfo())
		counts.set(type, (counts.get(type) || 0) + 1)
	return counts
}

/**
 * 汇总两次快照间的活跃资源净增长：总增量与最大单类型增量。
 * @param {Map<string, number>} after 之后
 * @param {Map<string, number>} before 之前
 * @returns {{ total: number, maxType: number }} 增长统计
 */
export function activeResourceDelta(after, before) {
	let total = 0
	let maxType = 0
	for (const [type, count] of after) {
		const delta = count - (before.get(type) || 0)
		if (delta <= 0) continue
		total += delta
		if (delta > maxType) maxType = delta
	}
	return { total, maxType }
}

/**
 * 强制 GC（两次 + 让出事件循环）后返回当前堆占用，用于拿“未引用即回收”之后的真实保留内存。
 * 这样 retained-closure 这类纯内存泄漏（如旧的 nostr 每次 send 保留错误闭包）也能被抓住，
 * 而不只抓住“连接未关闭”。
 * @returns {Promise<number>} 强制 GC 后的堆占用（字节）
 */
export async function heapUsedAfterGc() {
	gc()
	await new Promise(resolve => setTimeout(resolve, 20))
	gc()
	await new Promise(resolve => setTimeout(resolve, 20))
	return process.memoryUsage().heapUsed
}
