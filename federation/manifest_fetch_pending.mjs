import { verifySignedPublicManifest } from '../files/public_manifest.mjs'

/** @type {Map<string, { expectedKey: string, timer: ReturnType<typeof setTimeout>, resolve: (v: object | null) => void }>} */
export const pendingManifestFetches = new Map()

/** 并发 pending manifest fetch 上限。 */
export const MAX_PENDING_MANIFEST_FETCHES = 512

/**
 * @param {string} ownerEntityHash owner
 * @param {string} logicalPath 路径
 * @returns {string} 期望键
 */
export function manifestFetchExpectedKey(ownerEntityHash, logicalPath) {
	return `${String(ownerEntityHash || '').trim().toLowerCase()}\0${String(logicalPath || '').trim().replace(/^\/+/, '')}`
}

/**
 * @param {string} key requestId
 * @param {string} expectedKey owner+path 复合键
 * @param {number} timeoutMs 超时毫秒
 * @returns {{ done: Promise<object | null>, cancel: () => void }} 等待 Promise 与取消
 */
export function registerManifestFetchWait(key, expectedKey, timeoutMs) {
	if (!key || pendingManifestFetches.size >= MAX_PENDING_MANIFEST_FETCHES)
		return {
			done: Promise.resolve(null),
			/**
			 *
			 */
			cancel: () => { },
		}

	/** @type {(value: object | null) => void} */
	let settle
	const done = new Promise(resolve => {
		settle = resolve
	})
	const timer = setTimeout(() => {
		pendingManifestFetches.delete(key)
		settle(null)
	}, timeoutMs)

	pendingManifestFetches.set(key, {
		expectedKey,
		timer,
		/**
		 * @param {object | null} value 验签后的 manifest，超时/取消为 null
		 */
		resolve: value => {
			clearTimeout(timer)
			pendingManifestFetches.delete(key)
			settle(value)
		},
	})

	return {
		done,
		/**
		 *
		 */
		cancel: () => {
			clearTimeout(timer)
			pendingManifestFetches.delete(key)
			settle(null)
		},
	}
}

/**
 * 处理 fed_manifest_data：验签通过后 resolve pending。
 * @param {object} payload 入站载荷
 * @returns {Promise<boolean>} 是否命中并完成等待
 */
export async function resolvePendingManifestFetch(payload) {
	const requestId = String(payload?.requestId || '')
	if (!requestId) return false
	const entry = pendingManifestFetches.get(requestId)
	if (!entry) return false

	const verified = await verifySignedPublicManifest(payload?.manifest)
	if (!verified) return false
	const key = manifestFetchExpectedKey(verified.ownerEntityHash, verified.logicalPath)
	if (key !== entry.expectedKey) return false

	entry.resolve(verified)
	return true
}
