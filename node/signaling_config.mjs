import process from 'node:process'

/** @typedef {'none' | 'rewrite-loopback' | 'drop'} IceLocalHostnamePolicy */

/**
 * @typedef {{
 *   relayOverride: string[] | null
 *   iceLocalHostnamePolicy: IceLocalHostnamePolicy
 *   trickleIceOff: boolean
 * }} SignalingRuntimeConfig
 */

const ICE_LOCAL_HOSTNAME_POLICIES = new Set(['none', 'rewrite-loopback', 'drop'])

/**
 * 生产默认：win32 丢弃 `.local` host candidate；其它平台不过滤。
 * @returns {SignalingRuntimeConfig} 默认信令运行时配置
 */
export function defaultSignalingRuntimeConfig() {
	const iceLocalHostnamePolicy = process.platform === 'win32' ? 'drop' : 'none'
	return {
		relayOverride: null,
		iceLocalHostnamePolicy,
		trickleIceOff: iceLocalHostnamePolicy !== 'none',
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
	let { relayOverride } = base
	if (Object.prototype.hasOwnProperty.call(patch, 'relayOverride'))
		relayOverride = patch.relayOverride == null
			? null
			: [...new Set((Array.isArray(patch.relayOverride) ? patch.relayOverride : [])
				.map(url => String(url || '').trim())
				.filter(url => url.startsWith('wss://')))]
	return {
		relayOverride,
		iceLocalHostnamePolicy,
		trickleIceOff: patch.trickleIceOff !== undefined ? !!patch.trickleIceOff : iceLocalHostnamePolicy !== 'none',
	}
}
