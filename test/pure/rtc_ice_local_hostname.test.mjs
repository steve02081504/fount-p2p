import { test } from 'node:test'

import { applyIceLocalHostnamePolicy, filterIceLocalHostnameCandidate } from '../../link/rtc/index.mjs'
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
