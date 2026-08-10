import { randomUUID } from 'node:crypto'

import {
	manifestFetchExpectedKey,
	MAX_PENDING_MANIFEST_FETCHES,
	registerManifestFetchWait,
} from '../federation/manifest_fetch_pending.mjs'
import { isWritableLocalEntity } from '../node/identity.mjs'
import { getEntityStore } from '../node/instance.mjs'
import { ms } from '../utils/duration.mjs'
import { createInflightTable } from '../utils/inflight_table.mjs'

import { resolveNodeHash } from './chunk_provider_registry.mjs'
import { loadFileManifest, saveFileManifest } from './evfs.mjs'
import { fanoutFedFetch } from './fetch_fanout.mjs'
import { normalizeFileManifest } from './manifest.mjs'
import { shouldPreferIncomingPublicManifest } from './public_manifest.mjs'

const DEFAULT_MANIFEST_FETCH_TIMEOUT_MS = ms('8s')

/** 同 username+owner+path 共享一次 fanout；队满只丢已超基础超时的队首。 */
const manifestInflight = createInflightTable({
	maxSize: MAX_PENDING_MANIFEST_FETCHES,
	baseTimeoutMs: DEFAULT_MANIFEST_FETCH_TIMEOUT_MS,
})

/**
 * 拉取公开 manifest；默认不写盘。`cache: true` 或 `cachePublicManifest` 才缓存。
 * 本地已有 publicSig 时仍会 fanout 再校验，按 publishedAt 择新；超时则回退本地。
 * 同 key in-flight 去重；调用方外层超时不 abort，后台继续填缓存。
 * @param {{ username: string, ownerEntityHash: string, logicalPath: string, cache?: boolean, timeoutMs?: number }} context - 拉取上下文
 * @returns {Promise<import('./manifest.mjs').FileManifest | null>} 验签后的 manifest，失败为 null
 */
export async function fetchPublicManifest(context) {
	const ownerEntityHash = String(context.ownerEntityHash || '').trim().toLowerCase()
	const logicalPath = String(context.logicalPath || '').trim().replace(/^\/+/, '')
	const { username } = context
	if (!ownerEntityHash || !logicalPath || !username) return null

	const timeoutMs = Number(context.timeoutMs) > 0
		? Number(context.timeoutMs)
		: DEFAULT_MANIFEST_FETCH_TIMEOUT_MS
	const expectedKey = manifestFetchExpectedKey(ownerEntityHash, logicalPath)
	const inflightKey = `${username}\0${expectedKey}`

	// 先挂 in-flight（同步），再读本地 — 避免并发调用在 await 间隙各自 start
	const localPromise = loadFileManifest(ownerEntityHash, logicalPath)
	const shared = manifestInflight.acquire(inflightKey, () => {
		const requestId = randomUUID()
		const wait = registerManifestFetchWait(requestId, expectedKey, timeoutMs)
		void (async () => {
			try {
				const { nodeHash } = await resolveNodeHash(username)
				await fanoutFedFetch(username, 'fed_manifest_get', {
					requestId,
					nodeHash,
					ownerEntityHash,
					logicalPath,
				})
			}
			catch { /* pending wait 超时/cancel 负责 settle */ }
		})()
		return { done: wait.done, cancel: wait.cancel }
	})

	const local = await localPromise
	const hasLocalPublic = local?.transferKeyDescriptor?.type === 'public' && !!local?.meta?.publicSig
	if (!shared) return hasLocalPublic ? local : null

	const result = await shared

	if (result && (!hasLocalPublic || shouldPreferIncomingPublicManifest(local, result))) {
		if (context.cache === true)
			await cachePublicManifest(ownerEntityHash, logicalPath, result)
		return result
	}
	if (hasLocalPublic) return local
	return null
}

/**
 * 将已验签公开 manifest 写入本地缓存（显式 apply；`fetchPublicManifest` 默认不调用）。
 * @param {string} ownerEntityHash owner
 * @param {string} logicalPath 路径
 * @param {import('./manifest.mjs').FileManifest} incoming 已验签入站清单
 * @returns {Promise<void>}
 */
export async function cachePublicManifest(ownerEntityHash, logicalPath, incoming) {
	await maybeCacheIncomingPublicManifest(ownerEntityHash, logicalPath, incoming)
}

/**
 * @param {string} ownerEntityHash owner
 * @param {string} logicalPath 路径
 * @param {import('./manifest.mjs').FileManifest} incoming 已验签入站清单
 * @returns {Promise<void>}
 */
async function maybeCacheIncomingPublicManifest(ownerEntityHash, logicalPath, incoming) {
	if (isWritableLocalEntity(ownerEntityHash)) return
	const store = getEntityStore()
	const existing = await store.readManifest(ownerEntityHash, logicalPath)
	if (existing && !shouldPreferIncomingPublicManifest(existing, incoming)) return
	await saveFileManifest(incoming)
}

/**
 * 若本机有已签名公开 manifest 则响应 fed_manifest_get。
 * @param {string} username 用户
 * @param {object} payload 请求
 * @param {(response: object, peerId: string) => void} sendResponse 发送
 * @param {string} peerId 对端
 * @returns {Promise<void>}
 */
export async function handleIncomingManifestGet(username, payload, sendResponse, peerId) {
	void username
	const ownerEntityHash = String(payload?.ownerEntityHash || '').trim().toLowerCase()
	const logicalPath = String(payload?.logicalPath || '').trim().replace(/^\/+/, '')
	const requestId = String(payload?.requestId || '')
	if (!ownerEntityHash || !logicalPath || !requestId) return

	const raw = await getEntityStore().readManifest(ownerEntityHash, logicalPath)
	const manifest = normalizeFileManifest(raw)
	if (!manifest) return
	if (manifest.transferKeyDescriptor.type !== 'public') return
	if (!raw?.meta?.publicSig) return

	sendResponse({
		requestId,
		manifest: {
			...manifest,
			meta: { publicSig: raw.meta.publicSig },
		},
	}, peerId)
}
