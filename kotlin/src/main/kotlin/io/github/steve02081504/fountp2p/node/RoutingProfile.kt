package io.github.steve02081504.fountp2p.node

import io.github.steve02081504.fountp2p.federation.jsTruthy

/**
 * 路由 profile（等价 `node/routing_profile.mjs`）。
 *
 * JS 委托 `identity.mjs` 的 `getNodeTransportSettings` / `saveNodeTransportSettings`；
 * 但 `identity.mjs` 依赖尚未移植的 `mailbox/`，按移植计划延后。本文件只复刻 routing
 * profile 实际用到的 `batterySaver` 读写（直接操作 `node.json`），其余传输字段原样保留。
 */

/**
 * @param profile `default` 或 `low`（省电）
 * @return 写入后的当前 profile
 */
fun setRoutingProfile(profile: String): String {
	if (profile != "default" && profile != "low")
		throw IllegalArgumentException("p2p: setRoutingProfile expects default|low")
	writeBatterySaver(profile == "low")
	return getRoutingProfile()
}

/** @return 当前路由 profile */
fun getRoutingProfile(): String =
	if (readBatterySaver()) "low" else "default"

private const val NODE_JSON = "node"
private const val BATTERY_SAVER = "batterySaver"

/** @return `node.json` 中 batterySaver 的真值 */
private fun readBatterySaver(): Boolean {
	val data = readNodeJsonSync(NODE_JSON) as? Map<*, *> ?: return false
	return jsTruthy(data[BATTERY_SAVER])
}

/** @param value 写入 batterySaver（保留 node.json 其他字段） */
private fun writeBatterySaver(value: Boolean) {
	val data = readNodeJsonSync(NODE_JSON) as? Map<*, *>
	val merged = LinkedHashMap<String, Any?>()
	if (data != null) for ((key, item) in data) if (key is String) merged[key] = item
	merged[BATTERY_SAVER] = value
	writeNodeJsonSync(NODE_JSON, merged)
}
