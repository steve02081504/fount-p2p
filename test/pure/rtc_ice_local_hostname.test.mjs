import { test } from 'node:test'

const EventTargetCtor = globalThis.EventTarget
const EventCtor = globalThis.Event

import {
	applyIceLocalHostnamePolicy,
	filterIceLocalHostnameCandidate,
	wrapRtcPeerConnectionForIceLocalHostname,
} from '../../link/rtc/index.mjs'
import { assertEquals } from '../helpers/assert.mjs'

/** 测试用 ICE candidate */
class FakeIceCandidate {
	/**
	 * @param {{ candidate: string }} init candidate 初始化字段
	 */
	constructor(init) {
		this.candidate = init.candidate
	}
}

/** 测试用 W3C EventTarget RTCPeerConnection（node-rtc-connection ≥2.1.0 原生形态） */
class FakeRTC extends EventTargetCtor {
	/**
	 * @param {{ candidate: string, sdpMid?: string, sdpMLineIndex?: number } | null} candidate 要派发的 candidate
	 * @returns {boolean} dispatch 是否成功
	 */
	emitIce(candidate) {
		const event = new EventCtor('icecandidate')
		event.candidate = candidate
		return this.dispatchEvent(event)
	}
}

/**
 * @param {import('../../link/rtc/ice_local_hostname.mjs').IceLocalHostnamePolicy} policy ICE 本地主机名策略
 * @returns {InstanceType<typeof FakeRTC> & RTCPeerConnection} 包装后的 peer connection
 */
function createWrappedPeerConnection(policy) {
	const Wrapped = wrapRtcPeerConnectionForIceLocalHostname(
		/** @type {typeof RTCPeerConnection} */ /** @type {unknown} */ FakeRTC,
		/** @type {typeof RTCIceCandidate} */ /** @type {unknown} */ FakeIceCandidate,
		policy,
	)
	return /** @type {InstanceType<typeof FakeRTC> & RTCPeerConnection} */ new Wrapped()
}

test('applyIceLocalHostnamePolicy drop/rewrite/none', () => {
	const local = 'candidate:1 1 udp 2130706431 host.local 54321 typ host generation 0'
	assertEquals(applyIceLocalHostnamePolicy(local, 'none'), local)
	assertEquals(applyIceLocalHostnamePolicy(local, 'drop'), null)
	assertEquals(applyIceLocalHostnamePolicy(local, 'rewrite-loopback')?.includes('127.0.0.1'), true)
})

test('filterIceLocalHostnameCandidate returns null when dropped', () => {
	const { RTCIceCandidate } = globalThis
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

test('W3C wrap drops .local host before listeners see it', () => {
	const peerConnection = createWrappedPeerConnection('drop')
	/** @type {unknown[]} */
	const seen = []
	/**
	 * @param {RTCPeerConnectionIceEvent} event ICE candidate 事件
	 * @returns {void}
	 */
	const onIceCandidate = event => { seen.push(event) }
	peerConnection.onicecandidate = onIceCandidate
	assertEquals(peerConnection.onicecandidate, onIceCandidate)
	peerConnection.addEventListener('icecandidate', event => { seen.push(['listener', event]) })
	peerConnection.emitIce({ candidate: 'candidate:1 1 udp 2130706431 host.local 54321 typ host' })
	peerConnection.emitIce({ candidate: 'candidate:2 1 udp 2130706431 10.0.0.1 54321 typ host' })
	peerConnection.emitIce(null)
	assertEquals(seen.length, 4)
	assertEquals(/** @type {{ candidate: { candidate: string } }} */ seen[0].candidate.candidate.includes('10.0.0.1'), true)
	assertEquals(/** @type {['listener', { candidate: { candidate: string } }]} */ seen[1][1].candidate.candidate.includes('10.0.0.1'), true)
	assertEquals(/** @type {{ candidate: null }} */ seen[2].candidate, null)
	assertEquals(/** @type {['listener', { candidate: null }]} */ seen[3][1].candidate, null)
})

test('W3C wrap rewrite-loopback only dispatches rewritten candidate', () => {
	const peerConnection = createWrappedPeerConnection('rewrite-loopback')
	/** @type {string[]} */
	const seen = []
	peerConnection.addEventListener('icecandidate', event => {
		seen.push(/** @type {{ candidate: { candidate: string } }} */ event.candidate.candidate)
	})
	peerConnection.emitIce({ candidate: 'candidate:1 1 udp 2130706431 host.local 54321 typ host' })
	assertEquals(seen.length, 1)
	assertEquals(seen[0].includes('127.0.0.1'), true)
	assertEquals(seen[0].includes('.local'), false)
})
