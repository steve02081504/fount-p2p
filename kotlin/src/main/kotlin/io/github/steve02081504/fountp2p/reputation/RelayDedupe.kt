package io.github.steve02081504.fountp2p.reputation

import io.github.steve02081504.fountp2p.core.Json

/**
 * 联邦中继信誉加分去重（纯函数）。
 * @param relayBumpSeen 已记录贡献
 * @param peerNodeHash 对端节点
 * @param dedupeKey 去重键
 * @param now 当前时间
 * @param dedupeMs 去重窗口
 * @return 24h 内已计过分则为 true
 */
fun relayBumpIsDuplicate(
	relayBumpSeen: List<Any?>,
	peerNodeHash: String?,
	dedupeKey: String?,
	now: Double = currentTimeMillisDouble(),
	dedupeMs: Double = tunableNumber(defaultReputationTunables(), "relayBumpDedupeMs", Double.NaN),
): Boolean {
	if (peerNodeHash.isNullOrEmpty()) return true
	val dedupe = if (!dedupeKey.isNullOrEmpty()) dedupeKey else "conn:$peerNodeHash"
	return relayBumpSeen.any { entry ->
		Json.str(Json.at(entry, "peerNodeHash")) == peerNodeHash &&
			Json.str(Json.at(entry, "key")) == dedupe &&
			now - jsNumberValue(Json.at(entry, "t")) <= dedupeMs
	}
}
