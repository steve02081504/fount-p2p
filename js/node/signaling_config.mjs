/**
 * 信令运行时配置。
 *
 * webrtc 通道不再有 `trickleIceOff`：本仓库的 ICE 候选是靠 description 一次性带出去的
 * （对端要先有 remoteDescription 才吃候选），所以「收齐后一次性发送」是信令层的固定语义，
 * 不是可配置项。`iceLocalHostnamePolicy` 是 ICE 阶梯的起点（见 [iceLocalHostnameLadder]）。
 */

/** @typedef {'none' | 'rewrite-loopback' | 'drop'} IceLocalHostnamePolicy */

/**
 * @typedef {{
 *   channels: ChannelsConfig
 * }} SignalingRuntimeConfig
 */

/**
 * @typedef {Record<string, object | boolean>} ChannelsConfig
 */

/**
 * ICE 本地主机名策略的升级阶梯（宽松度递增）。
 *
 * `.local`（mDNS）候选对端通常解析不了，所以从 `drop` 起；若丢弃后候选集为空，说明这台主机只产出了
 * mDNS 候选，就升到 `none` 让对端自己处理（对端支持 mDNS 时就能用上）。判据是运行时观测到的候选集，
 * 不是平台——任何后端、任何主机都走同一条流程。
 *
 * `rewrite-loopback` 不在阶梯里：它把候选改写成 `127.0.0.1`，只对同机有意义，发给跨机对端是坏候选。
 */
export const ICE_LOCAL_HOSTNAME_LADDER = Object.freeze(['drop', 'none'])

/** 各介质的默认 channel 配置；对象值是启用并覆盖默认。 */
const DEFAULT_CHANNEL_CONFIG = {
	nostr: true,
	lan: true,
	bt: true,
	webrtc: { iceLocalHostnamePolicy: ICE_LOCAL_HOSTNAME_LADDER[0] },
}

/**
 * 从起点策略推导要依次尝试的策略（宽松度递增），用于把「候选集为空」当成升级信号。
 * `rewrite-loopback` 作为显式起点时只试它自己：它是调试/同机用途，不应自动放宽成对外候选。
 * @param {IceLocalHostnamePolicy | undefined | null} [from] 起点策略；未配置/非阶梯项时用阶梯首项
 * @returns {IceLocalHostnamePolicy[]} 依次尝试的策略（至少一项）
 */
export function iceLocalHostnameLadder(from) {
	if (from === 'rewrite-loopback') return ['rewrite-loopback']
	if (!ICE_LOCAL_HOSTNAME_LADDER.includes(/** @type {IceLocalHostnamePolicy} */ (from)))
		return [...ICE_LOCAL_HOSTNAME_LADDER]
	const startIndex = ICE_LOCAL_HOSTNAME_LADDER.indexOf(/** @type {IceLocalHostnamePolicy} */ (from))
	return ICE_LOCAL_HOSTNAME_LADDER.slice(startIndex)
}

/**
 * 归一到完整 channels 记录：false 禁用，其余（undefined / true / object）启用并合并默认配置。
 * 未提及的通道保持默认启用。
 * @param {object | undefined} [raw] 原始 channels 配置
 * @returns {ChannelsConfig} 每个已知通道都有明确值（object | false）的完整记录
 */
function resolveChannels(raw = {}) {
	/** @type {ChannelsConfig} */
	const out = {}
	for (const name of Object.keys(DEFAULT_CHANNEL_CONFIG)) {
		const value = raw[name]
		out[name] = value !== false && { ...Object(DEFAULT_CHANNEL_CONFIG[name]), ...Object(value) }
	}
	return out
}

/**
 * 生成禁用全部通道的 channels 配置；`overrides` 可重新启用/覆盖指定通道。
 * @param {Record<string, object | boolean>} [overrides] 需覆盖的通道配置
 * @returns {ChannelsConfig} 除覆盖外全部 false 的 channels 配置
 */
export function disableAllChannels(overrides = {}) {
	/** @type {ChannelsConfig} */
	const disabledChannels = {}
	for (const name of Object.keys(DEFAULT_CHANNEL_CONFIG)) disabledChannels[name] = false
	return { ...disabledChannels, ...overrides }
}

/**
 * @returns {SignalingRuntimeConfig} 默认信令运行时配置
 */
export function defaultSignalingRuntimeConfig() {
	return { channels: resolveChannels() }
}

/**
 * @param {Partial<SignalingRuntimeConfig>} [patch] 合并字段
 * @returns {SignalingRuntimeConfig} 合并后的信令运行时配置
 */
export function resolveSignalingRuntimeConfig(patch = {}) {
	if (!patch || typeof patch !== 'object') return defaultSignalingRuntimeConfig()
	return { channels: resolveChannels(patch.channels) }
}
