package io.github.steve02081504.fountp2p.core

/**
 * 混合逻辑时钟 (Hybrid Logical Clock)
 * 用于分布式系统中的事件排序
 */
data class Hlc(val wall: Long, val logical: Long) {
	/**
	 * 更新 HLC（接收到远程事件时）
	 * @param remote 远程 HLC
	 * @return 合并规则后的新 HLC 实例
	 */
	fun update(remote: Hlc): Hlc {
		val localWall = System.currentTimeMillis()

		if (localWall > wall && localWall > remote.wall)
			return Hlc(localWall, 0)

		if (wall == remote.wall)
			return Hlc(wall, maxOf(logical, remote.logical) + 1)

		if (wall > remote.wall)
			return Hlc(wall, logical + 1)

		return Hlc(remote.wall, remote.logical + 1)
	}

	/**
	 * 递增 HLC（本地生成新事件时）
	 * @return tick 后的新实例
	 */
	fun tick(): Hlc {
		val localWall = System.currentTimeMillis()
		if (localWall > wall) return Hlc(localWall, 0)
		return Hlc(wall, logical + 1)
	}

	/**
	 * 比较两个 HLC
	 * @param other 另一个 HLC
	 * @return 小于零、零或大于零（与 `this - other` 同号）
	 */
	fun compareTo(other: Hlc): Int {
		if (wall != other.wall) return wall.compareTo(other.wall)
		return logical.compareTo(other.logical)
	}

	/** @return 可 JSON 序列化的纯对象 */
	fun toJson(): Map<String, Any?> = mapOf("wall" to wall, "logical" to logical)

	companion object {
		/** @return wall 为当前时间、logical 为 0 的实例 */
		fun now(): Hlc = Hlc(System.currentTimeMillis(), 0)

		/** @param json JSON 对象 */
		fun fromJson(json: Any?): Hlc {
			val map = json as? Map<*, *> ?: throw IllegalArgumentException("invalid HLC json")
			return Hlc(Json.long(map["wall"]) ?: 0L, Json.long(map["logical"]) ?: 0L)
		}
	}
}

/**
 * 生成新事件的 HLC：取上一个事件的 HLC 与当前墙上时间的合并结果（`update`），
 * 保证新 HLC 严格晚于 lastHlc（Lamport 单调性）且不早于 `wallMs`。
 *
 * @param lastHlcJson 上一事件的 HLC（来自已持久化事件；缺省时从当前时间起）
 * @param wallMs 当前事件的期望物理时间戳（ms）；缺省为 `System.currentTimeMillis()`
 * @return 新事件 HLC 的可序列化纯对象
 */
fun nextHlc(lastHlcJson: Any?, wallMs: Long? = null): Map<String, Any?> {
	val wall = if (wallMs != null && wallMs != Long.MIN_VALUE)
		maxOf(wallMs, System.currentTimeMillis())
	else
		System.currentTimeMillis()
	val remote = Hlc(wall, 0)
	val lastWall = (lastHlcJson as? Map<*, *>)?.get("wall")
	if (lastWall == null || lastWall !is Number)
		return remote.toJson()
	val last = Hlc.fromJson(lastHlcJson)
	return last.update(remote).toJson()
}
