import { createHash } from 'node:crypto'
import { test } from 'node:test'

import { bytesToBase64 } from '../../core/bytes_codec.mjs'
import { sha256Hex } from '../../crypto/crypto.mjs'
import { fetchChunk } from '../../files/chunk/fetch.mjs'
import {
	pendingChunkFetches,
	registerChunkFetchWait,
	resolvePendingChunkFetch,
} from '../../files/chunk/pending.mjs'
import {
	chunkBytesMatchHash,
	verifiedChunkBytes,
} from '../../files/chunk/verify.mjs'
import {
	DEFAULT_TRUST_GRAPH_OWNER,
	registerTrustGraphProvider,
} from '../../trust_graph/registry.mjs'
import { ms } from '../../utils/duration.mjs'
import { assertEquals } from '../helpers/assert.mjs'
import { initTestP2pNode } from '../helpers/node.mjs'
import { mkTestNodeDir, teardownTestNodeDir } from '../helpers/node_dir_leak.mjs'

const GOOD_BYTES = new TextEncoder().encode('chunk-payload')
const HASH = createHash('sha256').update(GOOD_BYTES).digest('hex')
const BAD_BYTES = new TextEncoder().encode('wrong-payload')

/**
 * @returns {{
 *   provider: {
 *     buildMergedGraph: () => Promise<Map<string, object>>,
 *     sendToNode: (username: string, nodeHash: string, action: string, payload: object) => Promise<boolean>,
 *     fanoutToTopNodes: (username: string, action: string, payload: object, limit: number) => Promise<number>,
 *   },
 *   sent: Array<{ nodeHash: string }>,
 *   fanouts: Array<{ action: string }>,
 * }} mock trust graph provider
 */
function createMockTrustGraph() {
	/** @type {Array<{ nodeHash: string }>} */
	const sent = []
	/** @type {Array<{ action: string }>} */
	const fanouts = []
	return {
		sent,
		fanouts,
		provider: {
			/** @returns {Promise<Map<string, object>>} 空信任图 */
			async buildMergedGraph() { return new Map() },
			/**
			 * @param {string} username - 用户名
			 * @param {string} nodeHash - 目标 nodeHash
			 * @returns {Promise<boolean>} 是否发送成功
			 */
			async sendToNode(username, nodeHash) { sent.push({ nodeHash }); return true },
			/**
			 * @param {string} username - 用户名
			 * @param {string} action - 动作
			 * @returns {Promise<number>} 扇出数量
			 */
			async fanoutToTopNodes(username, action) { fanouts.push({ action }); return 0 },
		},
	}
}

/**
 * @param {() => boolean} predicate 条件
 * @param {number} [timeoutMs] 等待上限
 * @returns {Promise<void>}
 */
async function waitUntil(predicate, timeoutMs = ms('2s')) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (predicate()) return
		await new Promise(resolve => setTimeout(resolve, 5))
	}
	throw new Error('waitUntil timeout')
}

/** 结算残留 pending，避免测试残留污染后续用例。 */
function settleAllPendingChunkFetches() {
	for (const [key, entry] of [...pendingChunkFetches.entries()]) {
		clearTimeout(entry.timer)
		pendingChunkFetches.delete(key)
		entry.finish(null)
	}
}

/**
 * @param {string} requestId 请求 id
 * @returns {{ done: Promise<Uint8Array | null>, resolved: () => Uint8Array | null | undefined }} 等待句柄
 */
function installChunkFetchWaiter(requestId) {
	/** @type {Uint8Array | null | undefined} */
	let resolved
	const { done } = registerChunkFetchWait(requestId, HASH, ms('1m'))
	void done.then(data => { resolved = data })
	return {
		done,
		/** @returns {Uint8Array | null | undefined} 已解析值（未完成时为 undefined） */
		resolved: () => resolved,
	}
}

test('chunkBytesMatchHash accepts matching digest', () => {
	assertEquals(chunkBytesMatchHash(HASH, GOOD_BYTES), true)
	assertEquals(verifiedChunkBytes(HASH, GOOD_BYTES)?.byteLength, GOOD_BYTES.byteLength)
})

test('chunkBytesMatchHash rejects mismatched digest', () => {
	assertEquals(chunkBytesMatchHash(HASH, BAD_BYTES), false)
	assertEquals(verifiedChunkBytes(HASH, BAD_BYTES), null)
})

test('resolvePendingChunkFetch ignores hash mismatch until valid response', async () => {
	const requestId = 'req-mismatch-then-match'
	const waiter = installChunkFetchWaiter(requestId)
	resolvePendingChunkFetch({ requestId, dataBase64: bytesToBase64(BAD_BYTES) })
	assertEquals(waiter.resolved(), undefined)
	assertEquals(pendingChunkFetches.has(requestId), true)
	resolvePendingChunkFetch({ requestId, dataBase64: bytesToBase64(GOOD_BYTES) })
	assertEquals((await waiter.done)?.byteLength, GOOD_BYTES.byteLength)
	assertEquals(pendingChunkFetches.has(requestId), false)
})

test('resolvePendingChunkFetch accepts matching hash', async () => {
	const requestId = 'req-match'
	const waiter = installChunkFetchWaiter(requestId)
	resolvePendingChunkFetch({ requestId, dataBase64: bytesToBase64(GOOD_BYTES) })
	assertEquals((await waiter.done)?.byteLength, GOOD_BYTES.byteLength)
})

test('fetchChunk with fanoutTargets sends only to canonical targets, no node-scope fanout', async () => {
	const nodeDirectory = await mkTestNodeDir('fount-chunk-tgt-')
	initTestP2pNode({ nodeDir: nodeDirectory })
	const mock = createMockTrustGraph()
	registerTrustGraphProvider(DEFAULT_TRUST_GRAPH_OWNER, mock.provider)
	try {
		const targetNodeHash = 'a'.repeat(64)
		const chunkData = new TextEncoder().encode('targeted-chunk')
		const chunkHash = sha256Hex(chunkData)
		const fetchPromise = fetchChunk({
			username: 'u',
			ciphertextHash: chunkHash,
			ownerEntityHash: 'b'.repeat(64),
			fanoutTargets: [targetNodeHash, targetNodeHash, 'not-hex', ''],
		})
		await waitUntil(() => mock.sent.length > 0)
		assertEquals(mock.sent.length, 1)
		assertEquals(mock.sent[0].nodeHash, targetNodeHash)
		assertEquals(mock.fanouts.length, 0)
		// 定向 fanout 后注入匹配响应，结算等待
		const [requestId] = pendingChunkFetches.keys()
		assertEquals(Boolean(requestId), true)
		assertEquals(resolvePendingChunkFetch({ requestId, dataBase64: bytesToBase64(chunkData) }), true)
		assertEquals((await fetchPromise)?.byteLength, chunkData.byteLength)
	}
	finally {
		settleAllPendingChunkFetches()
		await teardownTestNodeDir(nodeDirectory)
	}
})

test('fetchChunk without fanoutTargets keeps node-scope fanoutToTopNodes', async () => {
	const nodeDirectory = await mkTestNodeDir('fount-chunk-scope-')
	initTestP2pNode({ nodeDir: nodeDirectory })
	const mock = createMockTrustGraph()
	registerTrustGraphProvider(DEFAULT_TRUST_GRAPH_OWNER, mock.provider)
	try {
		const chunkData = new TextEncoder().encode('public-chunk')
		const chunkHash = sha256Hex(chunkData)
		const fetchPromise = fetchChunk({
			username: 'u',
			ciphertextHash: chunkHash,
			ownerEntityHash: 'c'.repeat(64),
		})
		await waitUntil(() => mock.fanouts.length > 0)
		assertEquals(mock.fanouts[0].action, 'fed_chunk_get')
		const [requestId] = pendingChunkFetches.keys()
		assertEquals(Boolean(requestId), true)
		assertEquals(resolvePendingChunkFetch({ requestId, dataBase64: bytesToBase64(chunkData) }), true)
		assertEquals((await fetchPromise)?.byteLength, chunkData.byteLength)
	}
	finally {
		settleAllPendingChunkFetches()
		await teardownTestNodeDir(nodeDirectory)
	}
})

test('fetchChunk targeted and public modes dedup separately by inflight key', async () => {
	const nodeDirectory = await mkTestNodeDir('fount-chunk-key-')
	initTestP2pNode({ nodeDir: nodeDirectory })
	const mock = createMockTrustGraph()
	registerTrustGraphProvider(DEFAULT_TRUST_GRAPH_OWNER, mock.provider)
	try {
		const chunkData = new TextEncoder().encode('dedup-chunk')
		const chunkHash = sha256Hex(chunkData)
		const targetNodeHash = 'd'.repeat(64)
		const targetedPromise = fetchChunk({
			username: 'u',
			ciphertextHash: chunkHash,
			ownerEntityHash: 'e'.repeat(64),
			fanoutTargets: [targetNodeHash],
		})
		const publicPromise = fetchChunk({
			username: 'u',
			ciphertextHash: chunkHash,
			ownerEntityHash: 'e'.repeat(64),
		})
		await waitUntil(() => pendingChunkFetches.size === 2)
		// 两个模式各一个 pending：targeted 只发目标集，public 走 node-scope
		assertEquals(mock.sent.filter(entry => entry.nodeHash === targetNodeHash).length, 1)
		assertEquals(mock.fanouts.length, 1)
		// 分别结算
		for (const requestId of pendingChunkFetches.keys())
			resolvePendingChunkFetch({ requestId, dataBase64: bytesToBase64(chunkData) })
		assertEquals((await targetedPromise)?.byteLength, chunkData.byteLength)
		assertEquals((await publicPromise)?.byteLength, chunkData.byteLength)
	}
	finally {
		settleAllPendingChunkFetches()
		await teardownTestNodeDir(nodeDirectory)
	}
})
