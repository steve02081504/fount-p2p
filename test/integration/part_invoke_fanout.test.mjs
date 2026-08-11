import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { initNode, resetNodeForTests } from '../../node/instance.mjs'
import {
	clearTrustGraphProvider,
	DEFAULT_TRUST_GRAPH_OWNER,
	registerTrustGraphProvider,
} from '../../trust_graph/registry.mjs'
import {
	collectPartInvokeResponses,
	partInvokeDataRows,
	partInvokeErrorMessages,
	PART_INVOKE_FANOUT_DEFAULT,
} from '../../wire/part/fanout.mjs'
import { attachPartWire } from '../../wire/part/ingress.mjs'
import { assert, assertEquals } from '../helpers/assert.mjs'

/**
 * @returns {Promise<string>} 临时 nodeDir
 */
async function tmpNodeDir() {
	return mkdtemp(path.join(os.tmpdir(), 'p2p-part-fanout-'))
}

/**
 * @returns {{
 *   wire: import('../../wire/adapter.mjs').WireAdapter
 *   handlers: Map<string, Set<Function>>
 *   sent: Array<{ name: string, payload: unknown, peerId: string | null }>
 * }} 内存 wire
 */
function createMemoryWire() {
	/** @type {Map<string, Set<Function>>} */
	const handlers = new Map()
	/** @type {Array<{ name: string, payload: unknown, peerId: string | null }>} */
	const sent = []
	return {
		handlers,
		sent,
		wire: {
			on(name, handler) {
				if (!handlers.has(name)) handlers.set(name, new Set())
				handlers.get(name).add(handler)
				return () => handlers.get(name)?.delete(handler)
			},
			send(name, payload, peerId) {
				sent.push({ name, payload, peerId })
			},
		},
	}
}

/**
 * @param {Map<string, Set<Function>>} handlers wire handlers
 * @param {string} name action
 * @param {unknown} payload 载荷
 * @param {string} peerId 对端
 * @returns {void}
 */
function dispatch(handlers, name, payload, peerId) {
	for (const handler of handlers.get(name) || [])
		handler(payload, peerId)
}

test('collectPartInvokeResponses gathers neighbor replies until maxResponses', async () => {
	const nodeDir = await tmpNodeDir()
	resetNodeForTests()
	clearTrustGraphProvider()
	initNode({ nodeDir })
	const { wire, handlers } = createMemoryWire()
	attachPartWire({ replicaUsername: 'alice' }, wire)

	/** @type {object[]} */
	const fanouts = []
	registerTrustGraphProvider(DEFAULT_TRUST_GRAPH_OWNER, {
		async buildMergedGraph() { return new Map() },
		pickTopNodes() { return [] },
		async sendToNode() { return false },
		async fanoutToTopNodes(_username, action, payload, limit) {
			fanouts.push({ action, payload, limit })
			queueMicrotask(() => {
				dispatch(handlers, 'part_invoke_response', {
					requestId: payload.requestId,
					partpath: payload.partpath,
					response: { result: { from: 'peer-a' } },
				}, 'peer-a')
				dispatch(handlers, 'part_invoke_response', {
					requestId: payload.requestId,
					partpath: payload.partpath,
					response: { result: { from: 'peer-b' } },
				}, 'peer-b')
			})
			return 2
		},
	})

	try {
		const replies = await collectPartInvokeResponses(
			'alice',
			'shells/social',
			{ kind: 'ping' },
			1000,
			2,
		)
		assertEquals(fanouts.length, 1)
		assertEquals(fanouts[0].action, 'part_invoke')
		assertEquals(fanouts[0].limit, 2)
		assert.ok(fanouts[0].payload.requestId)
		assertEquals(replies.length, 2)
		assertEquals(partInvokeDataRows(replies), [{ from: 'peer-a' }, { from: 'peer-b' }])
		assertEquals(partInvokeErrorMessages(replies), [])
	}
	finally {
		clearTrustGraphProvider()
		resetNodeForTests()
		await rm(nodeDir, { recursive: true, force: true })
	}
})

test('collectPartInvokeResponses finishes immediately when fanout sends zero', async () => {
	const nodeDir = await tmpNodeDir()
	resetNodeForTests()
	clearTrustGraphProvider()
	initNode({ nodeDir })
	attachPartWire({ replicaUsername: 'alice' }, createMemoryWire().wire)

	registerTrustGraphProvider(DEFAULT_TRUST_GRAPH_OWNER, {
		async buildMergedGraph() { return new Map() },
		pickTopNodes() { return [] },
		async sendToNode() { return false },
		async fanoutToTopNodes() { return 0 },
	})

	try {
		const replies = await collectPartInvokeResponses(
			'alice',
			'shells/cabinet',
			{ kind: 'cabinet_operation_pull', cabinetId: 'c1', haveOperationIds: [] },
			5000,
			PART_INVOKE_FANOUT_DEFAULT,
		)
		assertEquals(replies, [])
	}
	finally {
		clearTrustGraphProvider()
		resetNodeForTests()
		await rm(nodeDir, { recursive: true, force: true })
	}
})

test('partInvokeDataRows / partInvokeErrorMessages split result and error', () => {
	const rows = partInvokeDataRows([
		{ result: { ok: 1 } },
		{ error: { message: 'nope', code: 'NOPE' } },
		{ result: { ok: 2 } },
	])
	assertEquals(rows, [{ ok: 1 }, { ok: 2 }])
	assertEquals(partInvokeErrorMessages([
		{ result: { ok: 1 } },
		{ error: { message: 'nope', code: 'NOPE' } },
	]), ['nope'])
})
