package io.github.steve02081504.fountp2p.dag

/**
 * DAG 事件行读盘时剥离的本地扩展键（不得进入验签域 / 联邦 wire）。
 */

/** 落盘后 trusted 读路径仍须剥除的 sidecar 键。 */
val DAG_EVENT_LOCAL_EXTENSION_KEYS: Set<String> = setOf("receivedAt", "isRemote")

/**
 * @param row JSONL 行
 * @return 剥离扩展键后的副本
 */
fun stripDagEventLocalExtensions(row: Map<String, Any?>): Map<String, Any?> {
	val out = LinkedHashMap(row)
	out.keys.removeAll(DAG_EVENT_LOCAL_EXTENSION_KEYS)
	return out
}
