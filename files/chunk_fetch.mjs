import { randomUUID } from 'node:crypto'

import { bytesToBase64 } from '../core/bytes_codec.mjs'
import {
	MAX_PENDING_CHUNK_FETCHES,
	registerChunkFetchWait,
} from '../federation/chunk_fetch_pending.mjs'
import { ms } from '../utils/duration.mjs'
import { createInflightTable } from '../utils/inflight_table.mjs'

import { verifiedChunkBytes } from './chunk_fetch_verify.mjs'
import { fetchFederationChunk, resolveNodeHash } from './chunk_provider_registry.mjs'
import { getChunk, hasChunk, putChunk } from './chunk_store.mjs'
import { fanoutFedFetch } from './fetch_fanout.mjs'

const DEFAULT_CHUNK_FETCH_TIMEOUT_MS = ms('8s')

/** 同 username+hash 共享一次 fanout；队满只丢已超基础超时的队首。 */
const chunkInflight = createInflightTable({
	maxSize: MAX_PENDING_CHUNK_FETCHES,
	baseTimeoutMs: DEFAULT_CHUNK_FETCH_TIMEOUT_MS,
})

/**
 * @typedef {{
 *   username: string,
 *   ciphertextHash: string,
 *   ownerEntityHash?: string,
 *   groupId?: string,
 * }} FetchChunkContext
 */

/**
 * @param {FetchChunkContext} context 上下文
 * @returns {Promise<Uint8Array | null>} 密文块
 */
export async function fetchChunk(context) {
	const hash = String(context.ciphertextHash || '').trim().toLowerCase()
	const { username } = context
	if (!hash || !username) return null

	if (await hasChunk(hash))
		return new Uint8Array(await getChunk(hash))

	if (context.groupId) {
		const u8 = await fetchFederationChunk(username, context.groupId, hash)
		const verified = verifiedChunkBytes(hash, u8)
		if (verified) {
			await putChunk(hash, verified)
			return verified
		}
	}

	const inflightKey = `${username}\0${hash}`
	const shared = chunkInflight.acquire(inflightKey, () => {
		const requestId = randomUUID()
		const wait = registerChunkFetchWait(requestId, hash, DEFAULT_CHUNK_FETCH_TIMEOUT_MS)
		void (async () => {
			try {
				const { nodeHash } = await resolveNodeHash(username)
				await fanoutFedFetch(username, 'fed_chunk_get', {
					requestId,
					nodeHash,
					chunkHash: hash,
					ownerEntityHash: context.ownerEntityHash,
				})
			}
			catch { /* pending wait 超时/cancel 负责 settle */ }
		})()
		return { done: wait.done, cancel: wait.cancel }
	})
	if (!shared) return null

	const result = await shared
	const verified = verifiedChunkBytes(hash, result)
	if (verified) {
		await putChunk(hash, verified)
		return verified
	}

	return null
}

/**
 * 若本机有 chunk 则响应 fed_chunk_get。
 * @param {string} username 用户
 * @param {object} payload 请求
 * @param {(response: object, peerId: string) => void} sendResponse 发送
 * @param {string} peerId 对端
 * @returns {Promise<void>}
 */
export async function handleIncomingChunkGet(username, payload, sendResponse, peerId) {
	const hash = String(payload?.chunkHash || '').trim().toLowerCase()
	if (!hash) return
	if (!await hasChunk(hash)) return
	const chunkBytes = await getChunk(hash)
	if (!chunkBytes?.length) return
	sendResponse({ requestId: payload.requestId, dataBase64: bytesToBase64(chunkBytes) }, peerId)
}
