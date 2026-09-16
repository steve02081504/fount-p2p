package io.github.steve02081504.fountp2p.federation

import io.github.steve02081504.fountp2p.utils.LruMap

/** 进程内拓扑序 memo 上限（每条目持有整份 order 数组） */
private const val MEMO_MAX = 64

private class MemoEntry(val fp: String, val order: List<String>)

private val memoByKey = LruMap<String, MemoEntry>(MEMO_MAX)

/**
 * 进程内拓扑序 memo；`resolveOrder` 可接入磁盘缓存等实现。
 * @param memoKey 缓存键
 * @param fingerprint 文件 stat + 事件数指纹
 * @param resolveOrder 实际求序（含磁盘层）
 * @param force 强制重算
 * @return 拓扑序 event id
 */
fun resolveTopologicalOrderMemoCached(
	memoKey: String,
	fingerprint: String,
	resolveOrder: () -> List<String>,
	force: Boolean = false,
): List<String> {
	if (!force) {
		val cached = memoByKey[memoKey]
		if (cached != null && cached.fp == fingerprint && cached.order.isNotEmpty()) {
			memoByKey.touch(memoKey, cached)
			return cached.order
		}
	}
	val order = resolveOrder()
	memoByKey.touch(memoKey, MemoEntry(fingerprint, order))
	return order
}

/**
 * @param memoKey 缓存键
 */
fun invalidateTopologicalOrderMemo(memoKey: String) {
	memoByKey.remove(memoKey)
}

/** 测试用清空进程内 memo。 */
internal fun clearTopologicalOrderMemoForTests() {
	memoByKey.clear()
}
