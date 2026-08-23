import { test } from 'node:test'

import { loadNodeRtcPolyfill } from '../../link/rtc/index.mjs'
import { assertEquals } from '../helpers/assert.mjs'

/**
 * 强制走纯 JS 后端（native MODULE_NOT_FOUND）
 * @returns {Promise<import('../../link/rtc/index.mjs').NodeRtcPolyfill>}
 */
async function loadPureJsBackend() {
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

/**
 * 复现 Termux / 无 prebuild 平台：native addon MODULE_NOT_FOUND。
 * 修复前只能抛错或无 RTC；修复后应落到纯 JS 后端。
 */
test('loadNodeRtcPolyfill falls back when node-datachannel native is missing', async () => {
	const rtc = await loadPureJsBackend()
	assertEquals(typeof rtc.RTCPeerConnection, 'function')
	assertEquals(typeof rtc.RTCIceCandidate, 'function')
	assertEquals(rtc.backend, 'node-rtc-connection')
})

test('pure-js backend folds candidates into SDP after gathering completes (non-trickle contract)', async () => {
	const rtc = await loadPureJsBackend()
	/** @type {RTCPeerConnection} */
	const pc = new rtc.RTCPeerConnection(/** @type {RTCConfiguration} */ { iceServers: [] })
	try {
		pc.createDataChannel('c')
		await pc.setLocalDescription(await pc.createOffer())
		while (pc.iceGatheringState !== 'complete')
			await new Promise(resolve => setTimeout(resolve, 50))
		const sdp = /** @type {RTCSessionDescription} */ pc.localDescription.sdp
		assertEquals(pc.iceGatheringState, 'complete')
		assertEquals(/^a=candidate:/gm.test(sdp), true)
		assertEquals(/a=end-of-candidates/.test(sdp), true)
	}
	finally {
		pc.close()
	}
})
