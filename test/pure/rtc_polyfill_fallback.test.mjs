import { test } from 'node:test'

import { assertEquals } from '../helpers/assert.mjs'
import { loadPureJsBackend } from '../helpers/rtc_pure_js_backend.mjs'

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
		const peerConnection = new rtc.RTCPeerConnection(/** @type {RTCConfiguration} */ { iceServers: [] })
		try {
			peerConnection.createDataChannel('c')
			await peerConnection.setLocalDescription(await peerConnection.createOffer())
			const deadline = Date.now() + 30_000
			while (peerConnection.iceGatheringState !== 'complete' && Date.now() < deadline)
				await new Promise(resolve => setTimeout(resolve, 50))
			if (peerConnection.iceGatheringState !== 'complete')
				throw new Error(`ice gathering did not complete within deadline: ${peerConnection.iceGatheringState}`)
			const sdp = /** @type {RTCSessionDescription} */ peerConnection.localDescription.sdp
			assertEquals(peerConnection.iceGatheringState, 'complete')
			assertEquals(/^a=candidate:/gm.test(sdp), true)
			assertEquals(/a=end-of-candidates/.test(sdp), true)
		}
		finally {
			peerConnection.close()
		}
	})
