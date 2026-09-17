package io.github.steve02081504.fountp2p.node

import io.github.steve02081504.fountp2p.federation.jsTruthy

/**
 * 路由 profile（等价 `node/routing_profile.mjs`）。
 *
 * 直接委托 `node/identity.mjs` 的传输设置读写（[getNodeTransportSettings] / [saveNodeTransportSettings]）。
 */

/**
 * @param profile `default` 或 `low`（省电）
 * @return 写入后的当前 profile
 */
fun setRoutingProfile(profile: String): String {
	if (profile != "default" && profile != "low")
		throw IllegalArgumentException("p2p: setRoutingProfile expects default|low")
	saveNodeTransportSettings(mapOf("batterySaver" to (profile == "low")))
	return getRoutingProfile()
}

/** @return 当前路由 profile */
fun getRoutingProfile(): String =
	if (jsTruthy(getNodeTransportSettings()["batterySaver"])) "low" else "default"
