package io.github.steve02081504.fountp2p.timeline

import io.github.steve02081504.fountp2p.dag.topologicalCanonicalOrder

/**
 * `materializeFromEvents` 的物化结果：折叠后的状态与拓扑序。
 * @property state reducer 折叠后的状态
 * @property order 事件的规范拓扑序 id 列表
 */
data class MaterializeResult(val state: Map<String, Any?>, val order: List<String>)

/**
 * 拓扑序后按 reducer 表折叠事件列表。
 * @param events 原始事件
 * @param reducers 事件类型 → reducer
 * @param createInitialState 初始状态工厂
 * @return 物化结果与拓扑序
 */
fun materializeFromEvents(
	events: List<Map<String, Any?>>,
	reducers: Map<String, (Map<String, Any?>, Map<String, Any?>) -> Map<String, Any?>>,
	createInitialState: () -> Map<String, Any?>,
): MaterializeResult {
	val order = topologicalCanonicalOrder(events.map { event ->
		mapOf<String, Any?>(
			"id" to event["id"],
			"prev_event_ids" to event["prev_event_ids"],
			"hlc" to event["hlc"],
			"node_id" to event["node_id"],
		)
	})
	val byId = HashMap<String, Map<String, Any?>>()
	for (event in events) {
		val id = event["id"] as? String ?: continue
		byId[id] = event
	}
	var state = createInitialState()
	for (eventId in order) {
		val event = byId[eventId] ?: continue
		val reducer = reducers[event["type"] as? String] ?: continue
		state = reducer(state, event)
	}
	return MaterializeResult(state, order)
}
