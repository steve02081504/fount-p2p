import { test } from 'node:test'

import {
	annotateRtcPeerNodeHash,
	releaseRtcPeer,
	takeRtcJoinSlot,
} from '../../transport/rtc_connection_budget.mjs'
import { assertEquals } from '../helpers/assert.mjs'



const LIMITS = { maxActive: 8, maxJoinsPerMin: 120, trustedPeers: ['trusted-node'] }

test('single source cannot fill all rtc slots', () => {
	const room = 'room-source-cap'
	const sourceCap = Math.max(1, Math.floor(LIMITS.maxActive * 0.25))
	for (let i = 0; i < sourceCap; i++)
		assertEquals(takeRtcJoinSlot(room, `p${i}`, LIMITS, 'sybil-source'), true)
	assertEquals(takeRtcJoinSlot(room, 'p-extra', LIMITS, 'sybil-source'), false)
	for (let i = 0; i < sourceCap; i++) releaseRtcPeer(room, `p${i}`)
})

test('trusted peer annotated after identity keeps slot under load', () => {
	const room = 'room-trusted'
	const trustedPeer = 'peer-trusted'
	for (let i = 0; i < 7; i++)
		takeRtcJoinSlot(room, `fill${i}`, LIMITS, `src${i}`)
	takeRtcJoinSlot(room, trustedPeer, LIMITS, 'sybil-source')
	annotateRtcPeerNodeHash(room, trustedPeer, 'trusted-node', LIMITS)
	assertEquals(takeRtcJoinSlot(room, trustedPeer, LIMITS, 'sybil-source'), true)
	releaseRtcPeer(room, trustedPeer)
})
