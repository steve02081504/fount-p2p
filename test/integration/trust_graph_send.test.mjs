

/**
 * trust_graph sendToNode / user_room 定向投递单元测试。
 */
import { Buffer } from 'node:buffer'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'


import { deliverToUserRoomPeers } from '../../transport/user_room.mjs'
import {
	createDefaultTrustGraphProvider,
	DEFAULT_TRUST_GRAPH_OWNER,
	registerTrustGraphProvider,
	requireTrustGraphProvider,
} from '../../trust_graph/registry.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { initTestP2pNode } from '../helpers/node.mjs'
import { mkTestNodeDir, teardownTestNodeDir } from '../helpers/node_dir_leak.mjs'

test('sendToNode returns false for blank target node hash', async () => {
	registerTrustGraphProvider(DEFAULT_TRUST_GRAPH_OWNER, createDefaultTrustGraphProvider())
	assertEquals(await requireTrustGraphProvider(DEFAULT_TRUST_GRAPH_OWNER).sendToNode('test-user', '', 'mailbox-give', {}), false)
	assertEquals(await requireTrustGraphProvider(DEFAULT_TRUST_GRAPH_OWNER).sendToNode('test-user', '   ', 'mailbox-give', {}), false)
})

test('deliverToUserRoomPeers returns 0 when user room is unavailable', async () => {
	const nodeDir = await mkTestNodeDir('fount-deliver-')
	try {
		await writeFile(join(nodeDir, 'node.json'), JSON.stringify({ nodeSeedHex: Buffer.alloc(32, 3).toString('hex') }))
		initTestP2pNode({ nodeDir })
		assertEquals(await deliverToUserRoomPeers('__no_such_user__', 'mailbox-give', { x: 1 }), 0)
	}
	finally {
		await teardownTestNodeDir(nodeDir)
	}
})
