import { base64ToBytes } from '../../core/bytes_codec.mjs'
import { createFetchWaitTable } from '../../utils/fetch_wait.mjs'

import { verifiedChunkBytes } from './verify.mjs'

/** 并发 pending chunk fetch 上限。 */
export const MAX_PENDING_CHUNK_FETCHES = 2048

const table = createFetchWaitTable({ maxSize: MAX_PENDING_CHUNK_FETCHES })

/** @type {typeof table.pending} */
export const pendingChunkFetches = table.pending

/**
 * 注册 chunk 拉取等待槽（requestId 或 compositeKey）。
 * @param {string} key 唯一等待键
 * @param {string} expectedHash 期望 64 hex 密文哈希
 * @param {number} timeoutMs 超时毫秒
 * @param {{ rejectOnTimeout?: boolean }} [options] rejectOnTimeout 时 Promise 以 Error 拒绝
 * @returns {{ done: Promise<Uint8Array | null>, cancel: () => void }} 等待 Promise 与取消函数
 */
export function registerChunkFetchWait(key, expectedHash, timeoutMs, options = {}) {
	return table.register(key, expectedHash, timeoutMs, options)
}

/**
 * 按等待键解析入站 chunk 响应（校验哈希后 resolve）。
 * @param {string} key 等待键
 * @param {string} expectedHash 期望哈希
 * @param {Uint8Array | null} bytes 密文块
 * @returns {boolean} 是否命中并完成等待
 */
export function resolveChunkFetchWait(key, expectedHash, bytes) {
	const entry = table.peek(key)
	if (!entry || entry.expectedKey !== expectedHash) return false
	const verified = bytes ? verifiedChunkBytes(expectedHash, bytes) : null
	if (bytes && !verified) return false
	return table.settle(key, verified)
}

/**
 * 处理 fed_chunk_data / 带 requestId 的响应载荷。
 * @param {object} payload 入站载荷
 * @returns {boolean} 是否命中 pending
 */
export function resolvePendingChunkFetch(payload) {
	const requestId = typeof payload?.requestId === 'string' ? payload.requestId : ''
	if (!requestId) return false
	const entry = table.peek(requestId)
	if (!entry) return false
	// 没有 dataBase64 不是“未找到”：不存在可信的负响应，任何收到 requestId 的 peer 都能拿空包提前判负。
	// 交给正常超时，让其它诚实响应者仍有机会提供块。
	if (typeof payload?.dataBase64 !== 'string') return false
	try {
		return resolveChunkFetchWait(requestId, entry.expectedKey, base64ToBytes(payload.dataBase64))
	}
	catch { /* keep waiting */ }
	return false
}
