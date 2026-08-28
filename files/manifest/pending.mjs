import { compositeKey } from '../../core/composite_key.mjs'
import { createFetchWaitTable } from '../../utils/fetch_wait.mjs'

import { normalizeFileManifest } from './normalize.mjs'
import { verifySignedPublicManifest } from './public.mjs'

/** 并发 pending manifest fetch 上限。 */
export const MAX_PENDING_MANIFEST_FETCHES = 512

const table = createFetchWaitTable({ maxSize: MAX_PENDING_MANIFEST_FETCHES })

/** @type {typeof table.pending} */
export const pendingManifestFetches = table.pending

/**
 * @param {string} ownerEntityHash owner
 * @param {string} logicalPath 路径
 * @returns {string} 期望键
 */
export function manifestFetchExpectedKey(ownerEntityHash, logicalPath) {
	return compositeKey(ownerEntityHash, logicalPath.replace(/^\/+/, ''))
}

/**
 * @param {string} key requestId
 * @param {string} expectedKey owner+path 复合键
 * @param {number} timeoutMs 超时毫秒
 * @param {{ allowNonPublic?: boolean }} [options] allowNonPublic 时接受无签名的非 public manifest 结算
 * @returns {{ done: Promise<object | null>, cancel: () => void }} 等待 Promise 与取消
 */
export function registerManifestFetchWait(key, expectedKey, timeoutMs, options) {
	return table.register(key, expectedKey, timeoutMs, options)
}

/**
 * 处理 fed_manifest_data：public 验签通过或（allowNonPublic 槽位）非 public 校验通过后 resolve pending。
 * @param {object} payload 入站载荷
 * @returns {Promise<boolean>} 是否命中并完成等待
 */
export async function resolvePendingManifestFetch(payload) {
	const requestId = String(payload?.requestId || '')
	if (!requestId) return false
	const entry = table.peek(requestId)
	if (!entry) return false

	const verified = await verifySignedPublicManifest(payload?.manifest)
	if (verified) {
		const key = manifestFetchExpectedKey(verified.ownerEntityHash, verified.logicalPath)
		if (key !== entry.expectedKey) return false
		return table.settle(requestId, verified)
	}

	if (entry.options?.allowNonPublic) {
		const normalized = normalizeFileManifest(payload?.manifest)
		if (!normalized) return false
		const key = manifestFetchExpectedKey(normalized.ownerEntityHash, normalized.logicalPath)
		if (key !== entry.expectedKey) return false
		return table.settle(requestId, normalized)
	}

	return false
}
