package io.github.steve02081504.fountp2p.dag

/**
 * DAG 事件列表查询辅助。
 */

/** `findLastEventOfType` 的结果：命中事件与下标。 */
data class LastEventOfType(val event: Map<String, Any?>, val index: Int)

/**
 * @param events 事件列表
 * @param type 事件类型
 * @return 自后向前最近一条；未命中为 null
 */
fun findLastEventOfType(events: List<Map<String, Any?>>, type: String): LastEventOfType? {
	for (index in events.indices.reversed())
		if (events[index]["type"] == type) return LastEventOfType(events[index], index)
	return null
}
