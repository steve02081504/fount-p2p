import { createHash } from 'node:crypto'
import { test } from 'node:test'

import { bytesToBase64 } from '../../core/bytes_codec.mjs'
import {
	pendingChunkFetches,
	registerChunkFetchWait,
	resolvePendingChunkFetch,
} from '../../files/chunk/pending.mjs'
import {
	chunkBytesMatchHash,
	verifiedChunkBytes,
} from '../../files/chunk/verify.mjs'
import { ms } from '../../utils/duration.mjs'
import { assertEquals } from '../helpers/assert.mjs'

const GOOD_BYTES = new TextEncoder().encode('chunk-payload')
const HASH = createHash('sha256').update(GOOD_BYTES).digest('hex')
const BAD_BYTES = new TextEncoder().encode('wrong-payload')

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
