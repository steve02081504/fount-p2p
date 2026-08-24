import process from 'node:process'

/** @typedef {'none' | 'rewrite-loopback' | 'drop'} IceLocalHostnamePolicy */

/**
 * @typedef {{
 *   iceLocalHostnamePolicy: IceLocalHostnamePolicy
 *   trickleIceOff: boolean
 *   channels: ChannelsConfig
 * }} SignalingRuntimeConfig
 */

/**
 * @typedef {Record<string, object | boolean>} ChannelsConfig
 */

/** 各介质的默认 channel 配置；对象值是启用并覆盖默认。 */
const DEFAULT_CHANNEL_CONFIG = { nostr: true, lan: true, bt: true }

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

const ICE_LOCAL_HOSTNAME_POLICIES = new Set(['none', 'rewrite-loopback', 'drop'])

/**
 * 生产默认：win32 丢弃 `.local` host candidate；其它平台不过滤。
 * @returns {SignalingRuntimeConfig} 默认信令运行时配置
 */
export function defaultSignalingRuntimeConfig() {
	const iceLocalHostnamePolicy = process.platform === 'win32' ? 'drop' : 'none'
	return {
		iceLocalHostnamePolicy,
		trickleIceOff: iceLocalHostnamePolicy !== 'none',
		channels: resolveChannels(),
	}
}

/**
 * @param {Partial<SignalingRuntimeConfig>} [patch] 合并字段
 * @returns {SignalingRuntimeConfig} 合并后的信令运行时配置
 */
export function resolveSignalingRuntimeConfig(patch = {}) {
	const base = defaultSignalingRuntimeConfig()
	if (!patch || typeof patch !== 'object') return base
	const policyRaw = patch.iceLocalHostnamePolicy
	const iceLocalHostnamePolicy = ICE_LOCAL_HOSTNAME_POLICIES.has(/** @type {string} */ policyRaw)
		? /** @type {IceLocalHostnamePolicy} */ policyRaw
		: base.iceLocalHostnamePolicy
	return {
		iceLocalHostnamePolicy,
		trickleIceOff: patch.trickleIceOff !== undefined ? !!patch.trickleIceOff : iceLocalHostnamePolicy !== 'none',
		channels: resolveChannels(patch.channels),
	}
}
