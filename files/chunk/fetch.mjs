import { bytesToBase64 } from '../../core/bytes_codec.mjs'
import { assertHex64 } from '../../core/hexIds.mjs'
import { ms } from '../../utils/duration.mjs'
import { createInflightTable } from '../../utils/inflight_table.mjs'
import { beginFedFanoutFetch } from '../fed/fetch_shared.mjs'

import {
	MAX_PENDING_CHUNK_FETCHES,
	registerChunkFetchWait,
} from './pending.mjs'
import { fetchFederationChunk } from './provider_registry.mjs'
import { getChunk, hasChunk, putChunk } from './store.mjs'
import { verifiedChunkBytes } from './verify.mjs'

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
		const verified = verifiedChunkBytes(hash, await fetchFederationChunk(username, context.groupId, hash))
		if (verified) {
			await putChunk(hash, verified)
			return verified
		}
	}

	const shared = beginFedFanoutFetch({
		inflight: chunkInflight,
		inflightKey: `${username}\0${hash}`,
		username,
		action: 'fed_chunk_get',
		/**
		 * @param {string} requestId 请求 id
		 * @returns {{ done: Promise<Uint8Array | null>, cancel: () => void }} 等待句柄
		 */
		registerWait: requestId => registerChunkFetchWait(requestId, hash, DEFAULT_CHUNK_FETCH_TIMEOUT_MS),
		/**
		 * @param {string} requestId 请求 id
		 * @param {string} nodeHash 目标节点 hash
		 * @returns {object} fanout 载荷
		 */
		buildPayload: (requestId, nodeHash) => ({
			requestId,
			nodeHash,
			chunkHash: hash,
			ownerEntityHash: context.ownerEntityHash,
		}),
	})
	if (!shared) return null

	const verified = verifiedChunkBytes(hash, await shared)
	if (verified) {
		await putChunk(hash, verified)
		return verified
	}
	return null
}

/**
 * 若本机有 chunk 则响应 fed_chunk_get。
 * @param {object} payload 请求
 * @param {(response: object, peerId: string) => void} sendResponse 发送
 * @param {string} peerId 对端
 * @returns {Promise<void>}
 */
export async function handleIncomingChunkGet(payload, sendResponse, peerId) {
	let hash
	try {
		hash = assertHex64(payload?.chunkHash, 'chunkHash')
	}
	catch { return }
	if (!await hasChunk(hash)) return
	const chunkBytes = await getChunk(hash)
	if (!chunkBytes?.length) return
	sendResponse({ requestId: payload.requestId, dataBase64: bytesToBase64(chunkBytes) }, peerId)
}
