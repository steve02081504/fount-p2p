package io.github.steve02081504.fountp2p.permissions

import io.github.steve02081504.fountp2p.core.Json
import java.math.BigInteger

/**
 * Discord 式「按特定度分层」权限求值器工厂（JS `createLayeredEvaluator` 的等价物）。
 *
 * @param order 权限名有序列表
 * @param codec 位图编解码器
 * @param superuserBit 旁路全部 scope 覆写的权限位
 * @param everyoneRoleId scope 内最宽角色 id
 */
class LayeredEvaluator internal constructor(
	val order: List<String>,
	private val codec: PermissionCodec,
	private val superuserBit: BigInteger,
	private val everyoneRoleId: String,
) {
	/** @param permissions 权限对象 @return 按位编码 */
	fun encode(permissions: Map<String, Any?>?): BigInteger = codec.encode(permissions)

	/** @param bits 权限位 @return 各权限名到布尔值 */
	fun decode(bits: BigInteger): Map<String, Any?> = codec.decode(bits)

	/**
	 * @param member 成员
	 * @param roles 角色映射
	 * @param scopeId scope id（如 channelId）
	 * @param scopeOverrides scope 覆写表
	 * @return 最终权限
	 */
	fun calculate(
		member: Map<String, Any?>?,
		roles: Map<String, Any?>?,
		scopeId: String,
		scopeOverrides: Map<String, Any?>?,
	): Map<String, Any?> {
		val roleIds = Json.arr(member?.get("roles")) ?: emptyList()

		var baseBits = BigInteger.ZERO
		for (roleIdValue in roleIds) {
			val roleId = roleIdValue as? String ?: continue
			val role = Json.obj(Json.at(roles, roleId)) ?: continue
			baseBits = baseBits.or(encode(Json.obj(role["permissions"])))
		}

		if (superuserBit != BigInteger.ZERO && baseBits.and(superuserBit) != BigInteger.ZERO) {
			val perms = LinkedHashMap<String, Any?>()
			for (p in order) perms[p] = true
			return perms
		}

		var bits = baseBits
		val scopeOverride = Json.obj(Json.at(scopeOverrides, scopeId))
		if (scopeOverride != null) {
			val everyone = Json.obj(scopeOverride[everyoneRoleId])
			if (everyone != null)
				bits = applyDenyAllowOverride(bits, everyone) { encode(it) }

			val roleOverrides = ArrayList<Map<String, Any?>?>()
			for (roleIdValue in roleIds) {
				val roleId = roleIdValue as? String ?: continue
				if (roleId == everyoneRoleId) continue
				val override = Json.obj(scopeOverride[roleId])
				if (override != null) roleOverrides.add(override)
			}
			bits = mergeRoleOverrides(bits, roleOverrides) { encode(it) }
		}

		return decode(bits)
	}

	/**
	 * @param member 成员
	 * @param permission 权限名
	 * @param roles 角色映射
	 * @param scopeId scope id
	 * @param scopeOverrides scope 覆写表
	 * @return 是否具备权限
	 */
	fun has(
		member: Map<String, Any?>?,
		permission: String,
		roles: Map<String, Any?>?,
		scopeId: String,
		scopeOverrides: Map<String, Any?>?,
	): Boolean = calculate(member, roles, scopeId, scopeOverrides)[permission] == true
}

/**
 * @param schema 求值 schema
 * @return 分层权限求值器
 */
fun createLayeredEvaluator(schema: Map<String, Any?>): LayeredEvaluator {
	val order = (Json.arr(schema["order"]) ?: emptyList()).mapNotNull { it as? String }
	val codec = createPermissionCodec(order)
	val superuserName = Json.str(schema["superuserName"]) ?: ""
	// JS `1n << BigInt(indexOf(...))` 在未命中（-1）时抛 RangeError；BigInteger 负位移抛 ArithmeticException。
	val superuserBit = BigInteger.ONE.shiftLeft(order.indexOf(superuserName))
	val everyoneRoleId = Json.str(schema["everyoneRoleId"]) ?: "@everyone"
	return LayeredEvaluator(order, codec, superuserBit, everyoneRoleId)
}
