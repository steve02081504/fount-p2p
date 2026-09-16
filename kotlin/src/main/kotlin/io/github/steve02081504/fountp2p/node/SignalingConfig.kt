package io.github.steve02081504.fountp2p.node

/**
 * 信令运行时配置（等价 `node/signaling_config.mjs`）。
 *
 * JS 用 `process.platform === 'win32'` 选择 webrtc 的 iceLocalHostnamePolicy；
 * Kotlin/JVM 用 `os.name` 判断。
 */

/** webrtc 通道默认配置。 */
private fun defaultWebRtcConfig(): Map<String, Any?> {
	val iceLocalHostnamePolicy = if (isWindowsPlatform()) "drop" else "none"
	return linkedMapOf(
		"iceLocalHostnamePolicy" to iceLocalHostnamePolicy,
		"trickleIceOff" to (iceLocalHostnamePolicy != "none"),
	)
}

/** @return 是否 Windows 平台（等价 `process.platform === 'win32'`） */
private fun isWindowsPlatform(): Boolean =
	System.getProperty("os.name")?.lowercase()?.contains("win") == true

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
