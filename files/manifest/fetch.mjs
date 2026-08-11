import { isWritableLocalEntity } from '../../node/identity.mjs'
import { getEntityStore } from '../../node/instance.mjs'
import { ms } from '../../utils/duration.mjs'
import { createInflightTable } from '../../utils/inflight_table.mjs'
import { loadFileManifest, saveFileManifest } from '../evfs.mjs'
import { beginFedFanoutFetch } from '../fed/fetch_shared.mjs'

import { normalizeFileManifest } from './normalize.mjs'
import {
	manifestFetchExpectedKey,
	MAX_PENDING_MANIFEST_FETCHES,
	registerManifestFetchWait,
} from './pending.mjs'
import { shouldPreferIncomingPublicManifest } from './public.mjs'

const DEFAULT_MANIFEST_FETCH_TIMEOUT_MS = ms('8s')

/** 同 username+owner+path 共享一次 fanout；队满只丢已超基础超时的队首。 */
const manifestInflight = createInflightTable({
	maxSize: MAX_PENDING_MANIFEST_FETCHES,
	baseTimeoutMs: DEFAULT_MANIFEST_FETCH_TIMEOUT_MS,
})

/**
 * 拉取公开 manifest；默认不写盘。`cache: true` 或 `cachePublicManifest` 才缓存。
 * 本地已有 publicSig 时立即返回，并后台 fanout；`cache: true` 时按 publishedAt 择新写盘。
 * 冷 miss 仍等 fanout。同 key in-flight 去重；调用方外层超时不 abort，后台继续填缓存。
 * @param {{ username: string, ownerEntityHash: string, logicalPath: string, cache?: boolean, timeoutMs?: number }} context - 拉取上下文
 * @returns {Promise<import('./normalize.mjs').FileManifest | null>} 验签后的 manifest，失败为 null
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
	const wantCache = context.cache === true

	// 先挂 in-flight（同步），再读本地 — 避免并发调用在 await 间隙各自 start
	const localPromise = loadFileManifest(ownerEntityHash, logicalPath)
	const shared = beginFedFanoutFetch({
		inflight: manifestInflight,
		inflightKey: `${username}\0${expectedKey}`,
		username,
		action: 'fed_manifest_get',
		/**
		 *
		 * @param requestId
		 */
		registerWait: requestId => registerManifestFetchWait(requestId, expectedKey, timeoutMs),
		/**
		 *
		 * @param requestId
		 * @param nodeHash
		 */
		buildPayload: (requestId, nodeHash) => ({
			requestId,
			nodeHash,
			ownerEntityHash,
			logicalPath,
		}),
	})

	const local = await localPromise
	const hasLocalPublic = local?.transferKeyDescriptor?.type === 'public' && !!local?.meta?.publicSig
	if (!shared) return hasLocalPublic ? local : null

	if (hasLocalPublic) {
		if (wantCache) 
			void shared.then(async result => {
				if (result && shouldPreferIncomingPublicManifest(local, result))
					await cachePublicManifest(ownerEntityHash, logicalPath, result)
			})
		
		return local
	}

	const result = await shared
	if (!result) return null
	if (wantCache) await cachePublicManifest(ownerEntityHash, logicalPath, result)
	return result
}

/**
 * 将已验签公开 manifest 写入本地缓存（显式 apply；`fetchPublicManifest` 默认不调用）。
 * @param {string} ownerEntityHash owner
 * @param {string} logicalPath 路径
 * @param {import('./normalize.mjs').FileManifest} incoming 已验签入站清单
 * @returns {Promise<void>}
 */
export async function cachePublicManifest(ownerEntityHash, logicalPath, incoming) {
	if (isWritableLocalEntity(ownerEntityHash)) return
	const existing = await getEntityStore().readManifest(ownerEntityHash, logicalPath)
	if (existing && !shouldPreferIncomingPublicManifest(existing, incoming)) return
	await saveFileManifest(incoming)
}

/**
 * 若本机有已签名公开 manifest 则响应 fed_manifest_get。
 * @param {object} payload 请求
 * @param {(response: object, peerId: string) => void} sendResponse 发送
 * @param {string} peerId 对端
 * @returns {Promise<void>}
 */
export async function handleIncomingManifestGet(payload, sendResponse, peerId) {
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
