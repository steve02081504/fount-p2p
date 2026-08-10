import { test } from 'node:test'

import { loadNodeRtcPolyfill } from '../../link/rtc/index.mjs'
import { assertEquals } from '../helpers/assert.mjs'

/**
 * 复现 Termux / 无 prebuild 平台：native addon MODULE_NOT_FOUND。
 * 修复前只能抛错或无 RTC；修复后应落到纯 JS 后端。
 */
test('loadNodeRtcPolyfill falls back when node-datachannel native is missing', async () => {
	const rtc = await loadNodeRtcPolyfill({
		backends: [
			{
				id: 'node-datachannel',
				/**
				 * @returns {Promise<never>}
				 */
				async load() {
					throw Object.assign(
						new Error("Cannot find module '../../../build/Release/node_datachannel.node'"),
						{ code: 'MODULE_NOT_FOUND' },
					)
				},
			},
		],
	})
	assertEquals(typeof rtc.RTCPeerConnection, 'function')
	assertEquals(typeof rtc.RTCIceCandidate, 'function')
	assertEquals(rtc.backend, 'node-rtc-connection')
	assertEquals(rtc.forcesTrickleIce, true)
})
