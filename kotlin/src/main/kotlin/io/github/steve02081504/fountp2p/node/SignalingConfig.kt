package io.github.steve02081504.fountp2p.node

import io.github.steve02081504.fountp2p.link.rtc.IceLocalHostnamePolicy

/**
 * 信令运行时配置（等价 `node/signaling_config.mjs`）。
 *
 * webrtc 通道不再有 `trickleIceOff`：本仓库的 ICE 候选是靠 description 一次性带出去的
 * （对端要先有 remoteDescription 才吃候选），所以「收齐后一次性发送」是信令层的固定语义。
 * `iceLocalHostnamePolicy` 是 ICE 阶梯的起点（见 [iceLocalHostnameLadder]），不做平台分支。
 */

/**
 * ICE 本地主机名策略的升级阶梯（宽松度递增）。
 *
 * `.local`（mDNS）候选对端通常解析不了，所以从 `drop` 起；若丢弃后候选集为空，说明这台主机只产出了
 * mDNS 候选，就升到 `none` 让对端自己处理。判据是运行时观测到的候选集，不是平台。
 *
 * `rewrite-loopback` 不在阶梯里：它把候选改写成 `127.0.0.1`，只对同机有意义。
 */
val ICE_LOCAL_HOSTNAME_LADDER: List<IceLocalHostnamePolicy> = listOf("drop", "none")

/** webrtc 通道默认配置。 */
private fun defaultWebRtcConfig(): Map<String, Any?> = linkedMapOf(
	"iceLocalHostnamePolicy" to ICE_LOCAL_HOSTNAME_LADDER.first(),
)

/**
 * 从起点策略推导要依次尝试的策略（宽松度递增），用于把「候选集为空」当成升级信号。
 * `rewrite-loopback` 作为显式起点时只试它自己：它是调试/同机用途，不应自动放宽成对外候选。
 * @param from 起点策略；未配置/非阶梯项时用阶梯首项
 * @return 依次尝试的策略（至少一项）
 */
fun iceLocalHostnameLadder(from: IceLocalHostnamePolicy?): List<IceLocalHostnamePolicy> {
	if (from == "rewrite-loopback") return listOf("rewrite-loopback")
	val startIndex = ICE_LOCAL_HOSTNAME_LADDER.indexOf(from)
	if (startIndex < 0) return ICE_LOCAL_HOSTNAME_LADDER.toList()
	return ICE_LOCAL_HOSTNAME_LADDER.drop(startIndex)
}

/** 各介质的默认 channel 配置；对象值是启用并覆盖默认。 */
private val DEFAULT_CHANNEL_CONFIG: Map<String, Any?> = linkedMapOf(
	"nostr" to true,
	"lan" to true,
	"bt" to true,
	"webrtc" to defaultWebRtcConfig(),
)

/**
 * 归一到完整 channels 记录：false 禁用，其余（undefined / true / object）启用并合并默认配置。
 * 未提及的通道保持默认启用。
 * @param raw 原始 channels 配置
 * @return 每个已知通道都有明确值（object | false）的完整记录
 */
private fun resolveChannels(raw: Map<String, Any?>? = null): Map<String, Any?> {
	val out = LinkedHashMap<String, Any?>()
	for (name in DEFAULT_CHANNEL_CONFIG.keys) {
		val value = raw?.get(name)
		out[name] = if (value == false) false
		else {
			val merged = LinkedHashMap<String, Any?>()
			val defaults = DEFAULT_CHANNEL_CONFIG[name]
			if (defaults is Map<*, *>) for ((key, item) in defaults) if (key is String) merged[key] = item
			if (value is Map<*, *>) for ((key, item) in value) if (key is String) merged[key] = item
			merged
		}
	}
	return out
}

/**
 * 生成禁用全部通道的 channels 配置；`overrides` 可重新启用/覆盖指定通道。
 * @param overrides 需覆盖的通道配置
 * @return 除覆盖外全部 false 的 channels 配置
 */
fun disableAllChannels(overrides: Map<String, Any?>? = null): Map<String, Any?> {
	val disabledChannels = LinkedHashMap<String, Any?>()
	for (name in DEFAULT_CHANNEL_CONFIG.keys) disabledChannels[name] = false
	if (overrides != null) disabledChannels.putAll(overrides)
	return disabledChannels
}

/** @return 默认信令运行时配置 */
fun defaultSignalingRuntimeConfig(): Map<String, Any?> =
	linkedMapOf("channels" to resolveChannels(null))

/**
 * @param patch 合并字段
 * @return 合并后的信令运行时配置
 */
fun resolveSignalingRuntimeConfig(patch: Map<String, Any?>? = null): Map<String, Any?> {
	if (patch == null) return defaultSignalingRuntimeConfig()
	val channels = patch["channels"] as? Map<String, Any?>
	return linkedMapOf("channels" to resolveChannels(channels))
}
