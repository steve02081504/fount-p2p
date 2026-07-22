import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { initNode, resetNodeForTests } from '../../node/instance.mjs'
import {
	attachReputationSyncWire,
	pullReputationFromNode,
	resetReputationSyncForTests,
	setReputationPullTimeoutMsForTests,
	setTrustSyncDonors,
} from '../../node/reputation_sync.mjs'
import {
	configureLinkRegistry,
	getLinkRegistry,
	resetLinkRegistryForTests,
} from '../../transport/link_registry.mjs'
import {
	dispatchNodeScopeAction,
	hasNodeScopeAction,
	stopNodeScopeRuntime,
} from '../../transport/node_scope.mjs'
import { assert, assertEquals } from '../helpers/assert.mjs'

const HASH_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const HASH_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const HASH_C = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'

/**
 * @returns {Promise<string>} 临时 nodeDir 路径
 */
async function tmpNodeDir() {
	return mkdtemp(path.join(os.tmpdir(), 'p2p-repsync-'))
}

/**
 * @returns {void}
 */
function resetAll() {
	resetNodeForTests()
	resetLinkRegistryForTests()
	resetReputationSyncForTests()
	stopNodeScopeRuntime()
}

test('attachReputationSyncWire is refcounted: one dispose does not drop the other holder', async () => {
	const nodeDir = await tmpNodeDir()
	try {
		resetAll()
		initNode({ nodeDir })
		const a = attachReputationSyncWire()
		const b = attachReputationSyncWire()
		assertEquals(hasNodeScopeAction('rep_sync_req'), true)
		a()
		assertEquals(hasNodeScopeAction('rep_sync_req'), true)
		b()
		assertEquals(hasNodeScopeAction('rep_sync_req'), false)
	}
	finally {
		resetAll()
		await rm(nodeDir, { recursive: true, force: true })
	}
})

test('rep_sync_res from non-donor peerId is ignored; donor response accepted', async () => {
	const nodeDir = await tmpNodeDir()
	try {
		resetAll()
		configureLinkRegistry({ autoRegisterDiscoveryProviders: false, autoRegisterLinkProviders: false })
		initNode({ nodeDir })
		const registry = getLinkRegistry()
		/**
		 * @param {string} _hash 目标 nodeHash（测试中忽略）
		 * @param {{ payload: { requestId: string } }} envelope 出站 rep_sync_req envelope
		 * @returns {Promise<boolean>} 始终视为发送成功
		 */
		registry.sendToNodeLink = async (_hash, envelope) => {
			const requestId = envelope.payload.requestId
			queueMicrotask(() => {
				dispatchNodeScopeAction('rep_sync_res', {
					requestId,
					byNodeHash: { [HASH_C]: { score: 0.99 } },
				}, HASH_B)
				dispatchNodeScopeAction('rep_sync_res', {
					requestId,
					byNodeHash: { [HASH_C]: { score: 0.55 } },
				}, HASH_A)
			})
			return true
		}
		setTrustSyncDonors([HASH_A])
		const pulled = await pullReputationFromNode(HASH_A)
		assertEquals(pulled.byNodeHash[HASH_C].score, 0.55)
	}
	finally {
		resetAll()
		await rm(nodeDir, { recursive: true, force: true })
	}
})

test('pullReputationFromNode send failure clears timer (no unhandled rejection)', async () => {
	const nodeDir = await tmpNodeDir()
	/** @type {unknown[]} */
	const unhandled = []
	/**
	 * @param {unknown} reason rejection
	 * @returns {void}
	 */
	const onUnhandled = reason => { unhandled.push(reason) }
	process.on('unhandledRejection', onUnhandled)
	try {
		resetAll()
		configureLinkRegistry({ autoRegisterDiscoveryProviders: false, autoRegisterLinkProviders: false })
		initNode({ nodeDir })
		setReputationPullTimeoutMsForTests(50)
		const registry = getLinkRegistry()
		/**
		 * @returns {Promise<boolean>} 模拟发送失败
		 */
		registry.sendToNodeLink = async () => false
		setTrustSyncDonors([HASH_A])
		await assert.rejects(() => pullReputationFromNode(HASH_A), /send failed/)
		await new Promise(resolve => setTimeout(resolve, 120))
		assertEquals(unhandled.length, 0)
	}
	finally {
		process.off('unhandledRejection', onUnhandled)
		resetAll()
		await rm(nodeDir, { recursive: true, force: true })
	}
})
