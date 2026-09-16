package io.github.steve02081504.fountp2p.permissions

import io.github.steve02081504.fountp2p.core.Json
import java.math.BigInteger

/**
 * 分层 allow/deny 覆写：先去 deny 再叠 allow。
 */

/**
 * @param baseBits 基线权限位
 * @param override 覆写
 * @param encode 编码函数
 * @return 覆写后的权限位
 */
fun applyDenyAllowOverride(
	baseBits: BigInteger,
	override: Map<String, Any?>?,
	encode: (Map<String, Any?>?) -> BigInteger,
): BigInteger {
	if (override == null) return baseBits
	var bits = baseBits
	if (isTruthy(override["deny"]))
		bits = bits.andNot(encode(Json.obj(override["deny"])))
	if (isTruthy(override["allow"]))
		bits = bits.or(encode(Json.obj(override["allow"])))
	return bits
}

/**
 * 合并多个角色的 allow/deny 后整体应用（顺序无关）。
 * @param baseBits 基线权限位
 * @param overrides 覆写列表
 * @param encode 编码函数
 * @return 覆写后的权限位
 */
fun mergeRoleOverrides(
	baseBits: BigInteger,
	overrides: List<Map<String, Any?>?>,
	encode: (Map<String, Any?>?) -> BigInteger,
): BigInteger {
	var roleAllow = BigInteger.ZERO
	var roleDeny = BigInteger.ZERO
	for (override in overrides) {
		if (override == null) continue
		if (isTruthy(override["allow"]))
			roleAllow = roleAllow.or(encode(Json.obj(override["allow"])))
		if (isTruthy(override["deny"]))
			roleDeny = roleDeny.or(encode(Json.obj(override["deny"])))
	}
	return baseBits.andNot(roleDeny).or(roleAllow)
}
