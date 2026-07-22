import { test } from 'node:test'

import { applyIceLocalHostnamePolicy, filterIceLocalHostnameCandidate } from '../../transport/rtc_ice_local_hostname.mjs'
import { assertEquals } from '../helpers/assert.mjs'

test('applyIceLocalHostnamePolicy drop/rewrite/none', () => {
	const local = 'candidate:1 1 udp 2130706431 host.local 54321 typ host generation 0'
	assertEquals(applyIceLocalHostnamePolicy(local, 'none'), local)
	assertEquals(applyIceLocalHostnamePolicy(local, 'drop'), null)
	const rewritten = applyIceLocalHostnamePolicy(local, 'rewrite-loopback')
	assertEquals(rewritten?.includes('127.0.0.1'), true)
})

test('filterIceLocalHostnameCandidate returns null when dropped', () => {
	const RTCIceCandidate = globalThis.RTCIceCandidate
	if (!RTCIceCandidate) return
	const candidate = new RTCIceCandidate({ candidate: 'candidate:1 1 udp 2130706431 host.local 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 })
	assertEquals(filterIceLocalHostnameCandidate(candidate, RTCIceCandidate, 'drop'), null)
})
