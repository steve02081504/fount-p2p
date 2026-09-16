import { getNodeTransportSettings, saveNodeTransportSettings } from './identity.mjs'

/** @typedef {'default' | 'low'} RoutingProfile */

/**
 * @param {RoutingProfile} profile - `default` 或 `low`（省电）
 * @returns {RoutingProfile} 写入后的当前 profile
 */
export function setRoutingProfile(profile) {
	if (profile !== 'default' && profile !== 'low')
		throw new Error('p2p: setRoutingProfile expects default|low')
	saveNodeTransportSettings({ batterySaver: profile === 'low' })
	return getRoutingProfile()
}

/**
 * @returns {RoutingProfile} 当前路由 profile
 */
export function getRoutingProfile() {
	return getNodeTransportSettings().batterySaver ? 'low' : 'default'
}
