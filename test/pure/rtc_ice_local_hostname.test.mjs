import { EventEmitter } from 'node:events'
import { test } from 'node:test'

import {
	applyIceLocalHostnamePolicy,
	filterIceLocalHostnameCandidate,
	wrapRtcPeerConnectionForIceLocalHostname,
} from '../../link/rtc/index.mjs'
import { bridgePeerConnection } from '../../link/rtc/w3c_bridge.mjs'
import { assertEquals } from '../helpers/assert.mjs'

test('applyIceLocalHostnamePolicy drop/rewrite/none', () => {
	const local = 'candidate:1 1 udp 2130706431 host.local 54321 typ host generation 0'
	assertEquals(applyIceLocalHostnamePolicy(local, 'none'), local)
	assertEquals(applyIceLocalHostnamePolicy(local, 'drop'), null)
	assertEquals(applyIceLocalHostnamePolicy(local, 'rewrite-loopback')?.includes('127.0.0.1'), true)
})

test('filterIceLocalHostnameCandidate returns null when dropped', () => {
	const RTCIceCandidate = globalThis.RTCIceCandidate
	if (!RTCIceCandidate) return
	assertEquals(
		filterIceLocalHostnameCandidate(
			new RTCIceCandidate({ candidate: 'candidate:1 1 udp 2130706431 host.local 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 }),
			RTCIceCandidate,
			'drop',
		),
		null,
	)
})

test('bridged wrap drops .local host before listeners see it', () => {
	class FakeIceCandidate {
		/**
		 * @param {{ candidate: string }} init
		 */
		constructor(init) {
			this.candidate = init.candidate
		}
	}
	class FakeRTC extends EventEmitter {
		/**
		 * @param {{ candidate: string } | null} candidate
		 */
		emitIce(candidate) {
			this.emit('icecandidate', { candidate })
		}
	}
	const Bridged = bridgePeerConnection(/** @type {typeof RTCPeerConnection} */ (/** @type {unknown} */ (FakeRTC)))
	const Wrapped = wrapRtcPeerConnectionForIceLocalHostname(
		/** @type {typeof RTCPeerConnection} */ (/** @type {unknown} */ (Bridged)),
		/** @type {typeof RTCIceCandidate} */ (/** @type {unknown} */ (FakeIceCandidate)),
		'drop',
	)
	const pc = /** @type {InstanceType<typeof FakeRTC> & RTCPeerConnection} */ (new Wrapped())
	/** @type {unknown[]} */
	const seen = []
	pc.onicecandidate = event => { seen.push(event) }
	pc.addEventListener('icecandidate', event => { seen.push(['listener', event]) })
	pc.emitIce({ candidate: 'candidate:1 1 udp 2130706431 host.local 54321 typ host' })
	pc.emitIce({ candidate: 'candidate:2 1 udp 2130706431 10.0.0.1 54321 typ host' })
	pc.emitIce(null)
	assertEquals(seen.length, 4)
	assertEquals(/** @type {{ candidate: { candidate: string } }} */ (seen[0]).candidate.candidate.includes('10.0.0.1'), true)
	assertEquals(/** @type {['listener', { candidate: { candidate: string } }]} */ (seen[1])[1].candidate.candidate.includes('10.0.0.1'), true)
	assertEquals(/** @type {{ candidate: null }} */ (seen[2]).candidate, null)
	assertEquals(/** @type {['listener', { candidate: null }]} */ (seen[3])[1].candidate, null)
})

test('bridged wrap rewrite-loopback only dispatches rewritten candidate', () => {
	class FakeIceCandidate {
		/**
		 * @param {{ candidate: string }} init
		 */
		constructor(init) {
			this.candidate = init.candidate
		}
	}
	class FakeRTC extends EventEmitter {
		/**
		 * @param {{ candidate: string }} candidate
		 */
		emitIce(candidate) {
			this.emit('icecandidate', { candidate })
		}
	}
	const Bridged = bridgePeerConnection(/** @type {typeof RTCPeerConnection} */ (/** @type {unknown} */ (FakeRTC)))
	const Wrapped = wrapRtcPeerConnectionForIceLocalHostname(
		/** @type {typeof RTCPeerConnection} */ (/** @type {unknown} */ (Bridged)),
		/** @type {typeof RTCIceCandidate} */ (/** @type {unknown} */ (FakeIceCandidate)),
		'rewrite-loopback',
	)
	const pc = /** @type {InstanceType<typeof FakeRTC> & RTCPeerConnection} */ (new Wrapped())
	/** @type {string[]} */
	const seen = []
	pc.addEventListener('icecandidate', event => {
		seen.push(/** @type {{ candidate: { candidate: string } }} */ (event).candidate.candidate)
	})
	pc.emitIce({ candidate: 'candidate:1 1 udp 2130706431 host.local 54321 typ host' })
	assertEquals(seen.length, 1)
	assertEquals(seen[0].includes('127.0.0.1'), true)
	assertEquals(seen[0].includes('.local'), false)
})
