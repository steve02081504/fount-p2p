package io.github.steve02081504.fountp2p.permissions

import io.github.steve02081504.fountp2p.core.JsonUndefined
import java.math.BigInteger

/**
 * 通用权限位图编解码（JS `createPermissionCodec` 的等价物）。
 *
 * JS 用 `bigint` 表示位图，Kotlin 用 [BigInteger]（Android/JVM 无原生无界整数）。
 * @param order 权限名有序列表（位序固定）
 */
class PermissionCodec internal constructor(order: List<String>) {
	private val names: List<String> = ArrayList(order)

	/** @return 权限名有序列表（位序固定）。 */
	fun names(): List<String> = names

	/**
	 * @param permissions 权限对象（值按 JS 真值判定）
	 * @return 按位编码
	 */
	fun encode(permissions: Map<String, Any?>?): BigInteger {
		var bits = BigInteger.ZERO
		if (permissions == null) return bits
		for (index in names.indices)
			if (isTruthy(permissions[names[index]]))
				bits = bits.setBit(index)
		return bits
	}

	/**
	 * @param bits 权限位
	 * @return 各权限名到布尔值
	 */
	fun decode(bits: BigInteger): Map<String, Any?> {
		val permissions = LinkedHashMap<String, Any?>()
		for (index in names.indices)
			permissions[names[index]] = bits.testBit(index)
		return permissions
	}
}

/**
 * @param order 权限名有序列表（位序固定）
 * @return 位图编解码器
 */
fun createPermissionCodec(order: List<String>): PermissionCodec = PermissionCodec(order)

/**
 * 等价 JS 真值判定。
 * @param value 任意值
 * @return 是否 JS 真值
 */
internal fun isTruthy(value: Any?): Boolean = when (value) {
	null, JsonUndefined -> false
	is Boolean -> value
	is Number -> {
		val d = value.toDouble()
		!d.isNaN() && d != 0.0
	}
	is String -> value.isNotEmpty()
	else -> true
}
