package io.github.steve02081504.fountp2p.registries

import io.github.steve02081504.fountp2p.core.JsonUndefined

/**
 * 事件 type 元数据注册表（`registries/event_type.mjs` 的等价实现）。
 */

/** 单个事件 type 的元数据：标志位 → 布尔。 */
typealias EventTypeFlags = Map<String, Any?>

/** ownerId → 事件 type 元数据。 */
private val defsByOwner = LinkedHashMap<String, Map<String, EventTypeFlags>>()

/**
 * @param ownerId 注册方
 * @param defs 事件 type 元数据
 */
fun registerEventTypeDefs(ownerId: String, defs: Map<String, EventTypeFlags>) {
	defsByOwner[ownerId] = defs
}

/**
 * @param ownerId 注册方
 */
fun unregisterEventTypeDefs(ownerId: String) {
	defsByOwner.remove(ownerId)
}

/** 清空注册表。 */
fun clearEventTypeRegistry() {
	defsByOwner.clear()
}

/** @return 合并后的 defs（后注册的 owner 覆盖先前的同名 type） */
fun mergedEventTypeDefs(): Map<String, EventTypeFlags> {
	val merged = LinkedHashMap<String, EventTypeFlags>()
	for (defs in defsByOwner.values) merged.putAll(defs)
	return merged
}

/**
 * @param flag 标志位名
 * @return 含该标志的事件 type 集合
 */
fun typesWithFlag(flag: String): Set<String> =
	mergedEventTypeDefs().filter { (_, f) -> flagEnabled(f[flag]) }.keys

/** §8 治理分叉选支：祖先闭包内计入信誉加权的类型。 */
fun getGovernanceAuthzTypes(): Set<String> = typesWithFlag("governance")

/** 裁剪时不得早于最早一条权限锚点事件（§7.1）。 */
fun getPermissionAnchorTypes(): Set<String> = typesWithFlag("permissionAnchor")

/** JS 真值语义。 */
private fun flagEnabled(value: Any?): Boolean = when (value) {
	null, JsonUndefined -> false
	is Boolean -> value
	is Number -> {
		val d = value.toDouble()
		d != 0.0 && !d.isNaN()
	}
	is String -> value.isNotEmpty()
	else -> true
}
