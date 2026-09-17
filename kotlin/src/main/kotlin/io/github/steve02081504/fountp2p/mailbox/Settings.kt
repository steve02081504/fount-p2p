package io.github.steve02081504.fountp2p.mailbox

import io.github.steve02081504.fountp2p.core.JsonUndefined
import io.github.steve02081504.fountp2p.federation.jsNumber
import io.github.steve02081504.fountp2p.federation.jsNumberOr
import io.github.steve02081504.fountp2p.trust_graph.resolveMailboxRelayFanout
import io.github.steve02081504.fountp2p.trust_graph.resolveMailboxWantFanout
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * Mailbox 路由配置规范化。
 *
 * 等价 `js/mailbox/settings.mjs`。
 */

/** `mailbox/tunables.json` 的等价默认值（数值统一为 [Double]）。 */
val DEFAULT_MAILBOX_TUNABLES: Map<String, Any?> = linkedMapOf(
	"maxHop" to 3.0,
	"relayFanoutTrustedFloor" to 3.0,
	"relayFanoutTrustedRatio" to 0.3,
	"relayFanoutTrustedCap" to 32.0,
	"relayFanoutNormal" to 3.0,
	"wantFanoutFloor" to 3.0,
	"wantFanoutRatio" to 0.4,
	"wantFanoutCap" to 32.0,
	"networkBudgetPerRound" to 64.0,
	"networkBudgetPerPeerRatio" to 2.0,
)

/** 读取对象成员；缺失键返回 [JsonUndefined]，对应 JS `obj?.key`（区分「缺失」与显式 null）。 */
private fun member(map: Map<String, Any?>, key: String): Any? =
	if (map.containsKey(key)) map[key] else JsonUndefined

/**
 * @param raw 节点 mailbox 配置片段
 * @param peerCount 已知在线 relay 候选数（0 时用 floor）
 * @return 规范化 mailbox 配置（键序同 JS）
 */
fun normalizeMailboxSettings(
	raw: Map<String, Any?>? = null,
	peerCount: Any? = 0,
): Map<String, Any?> {
	val r = raw ?: emptyMap()
	val tunables = DEFAULT_MAILBOX_TUNABLES
	val maxHop = max(1.0, min(8.0, jsNumberOr(jsNumber(member(r, "maxHop")), tunables["maxHop"] as Double)))
	val capTrusted = tunables["relayFanoutTrustedCap"] as? Double ?: 32.0
	val capWant = tunables["wantFanoutCap"] as? Double ?: 32.0
	val n = max(0.0, floor(jsNumberOr(jsNumber(peerCount), 0.0)))
	val relayFanoutTrusted = if (jsNumber(member(r, "relayFanoutTrusted")).isFinite())
		max(1.0, min(capTrusted, floor(jsNumber(member(r, "relayFanoutTrusted")))))
	else
		resolveMailboxRelayFanout(n, tunables).toDouble()
	val relayFanoutNormal = max(
		1.0,
		min(capTrusted, jsNumberOr(jsNumber(member(r, "relayFanoutNormal")), tunables["relayFanoutNormal"] as Double)),
	)
	val wantFanout = if (jsNumber(member(r, "wantFanout")).isFinite())
		max(1.0, min(capWant, floor(jsNumber(member(r, "wantFanout")))))
	else
		resolveMailboxWantFanout(n, tunables).toDouble()
	return linkedMapOf(
		"maxHop" to maxHop,
		"relayFanoutTrusted" to relayFanoutTrusted,
		"relayFanoutNormal" to relayFanoutNormal,
		"wantFanout" to wantFanout,
	)
}

/**
 * @param peerCount 已知在线 relay 候选数
 * @param raw 节点 mailbox 配置片段
 * @param batterySaver 省电模式
 * @return 缩放后的路由（键序同 JS）
 */
fun resolveMailboxRoutingForPeerCount(
	peerCount: Any?,
	raw: Map<String, Any?>? = null,
	batterySaver: Boolean = false,
): Map<String, Any?> {
	val base = normalizeMailboxSettings(raw, peerCount)
	if (!batterySaver)
		return LinkedHashMap(base).apply { this["batterySaver"] = false }
	val trusted = base["relayFanoutTrusted"] as Double
	val normal = base["relayFanoutNormal"] as Double
	val want = base["wantFanout"] as Double
	return linkedMapOf(
		"maxHop" to base["maxHop"],
		"relayFanoutTrusted" to max(1.0, ceil(trusted / 2)),
		"relayFanoutNormal" to max(1.0, ceil(normal / 2)),
		"wantFanout" to max(1.0, ceil(want / 2)),
		"batterySaver" to true,
	)
}
