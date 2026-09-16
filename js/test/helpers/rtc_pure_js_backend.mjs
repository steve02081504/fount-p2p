import { loadNodeRtcPolyfill } from '../../link/rtc/index.mjs'

/**
 * 强制走纯 JS 后端（native MODULE_NOT_FOUND）。
 * @returns {Promise<import('../../link/rtc/index.mjs').LoadedRtcPolyfill>} 纯 JS RTC 后端
 */
export async function loadPureJsBackend() {
	return loadNodeRtcPolyfill({
		backends: [
			{
				id: 'node-datachannel',
				/**
				 * @returns {Promise<never>} 模拟 native 模块缺失
				 */
				async load() {
					throw Object.assign(
						new Error('Cannot find module \'../../../build/Release/node_datachannel.node\''),
						{ code: 'MODULE_NOT_FOUND' },
					)
				},
			},
		],
	})
}
