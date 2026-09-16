package io.github.steve02081504.fountp2p.timeline

import io.github.steve02081504.fountp2p.dag.readJsonl
import io.github.steve02081504.fountp2p.federation.jsTruthy

/**
 * 读取 checkpoint 后按保留策略裁剪。
 * @param eventsFilePath events.jsonl 路径
 * @param readCheckpoint 读取 checkpoint 的异步回调
 * @param policy 保留策略
 * @param sanitize 行规范化
 * @return 裁剪统计
 */
suspend fun enforceDagRetention(
	eventsFilePath: String,
	readCheckpoint: suspend () -> Map<String, Any?>?,
	policy: Map<String, Any?>,
	sanitize: (Map<String, Any?>) -> Map<String, Any?> = { it },
): PruneStats {
	val checkpoint = readCheckpoint()
	return enforceTimelineEventRetention(eventsFilePath, checkpoint, policy, sanitize)
}

/**
 * 先按策略保留，再在事件数超过 compactTrigger 且存在 checkpoint 时做一次压缩裁剪。
 * @param eventsFilePath events.jsonl 路径
 * @param checkpoint 检查点
 * @param policy 保留策略
 * @param sanitize 行规范化
 * @param compactTrigger 压缩触发的事件数阈值
 */
suspend fun runTimelineMaintenance(
	eventsFilePath: String,
	checkpoint: Map<String, Any?>?,
	policy: Map<String, Any?>,
	sanitize: (Map<String, Any?>) -> Map<String, Any?>,
	compactTrigger: Double,
) {
	enforceTimelineEventRetention(eventsFilePath, checkpoint, policy, sanitize)
	val count = readJsonl(eventsFilePath, sanitize).size
	if (count.toDouble() > compactTrigger && jsTruthy(checkpoint?.get("checkpoint_event_id")))
		pruneEventsJsonlAfterCheckpoint(eventsFilePath, checkpoint, sanitize)
}
