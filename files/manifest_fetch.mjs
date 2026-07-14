import { randomUUID } from 'node:crypto'

import {
	manifestFetchExpectedKey,
	MAX_PENDING_MANIFEST_FETCHES,
	pendingManifestFetches,
	registerManifestFetchWait,
} from '../federation/manifest_fetch_pending.mjs'
import { isWritableLocalEntity } from '../node/identity.mjs'
import { getEntityStore } from '../node/instance.mjs'

import { resolveNodeHash } from './chunk_provider_registry.mjs'
import { loadFileManifest, saveFileManifest } from './evfs.mjs'
import { fanoutFedFetch } from './fetch_fanout.mjs'
import { normalizeFileManifest } from './manifest.mjs'
import { shouldPreferIncomingPublicManifest } from './public_manifest.mjs'

/**
 * @param {{ username: string, ownerEntityHash: string, logicalPath: string }} context 上下文
 * @returns {Promise<import('./manifest.mjs').FileManifest | null>} 验签后的公开清单
 */
export async function fetchPublicManifest(context) {
	const ownerEntityHash = String(context.ownerEntityHash || '').trim().toLowerCase()
	const logicalPath = String(context.logicalPath || '').trim().replace(/^\/+/, '')
	const { username } = context
	if (!ownerEntityHash || !logicalPath || !username) return null

	const local = await loadFileManifest(ownerEntityHash, logicalPath)
	if (local?.transferKeyDescriptor?.type === 'public' && local?.meta?.publicSig)
		return local

	if (pendingManifestFetches.size >= MAX_PENDING_MANIFEST_FETCHES) return null

	const requestId = randomUUID()
	const { done } = registerManifestFetchWait(
		requestId,
		manifestFetchExpectedKey(ownerEntityHash, logicalPath),
		8000,
	)
	const { nodeHash } = await resolveNodeHash(username)
	const payload = {
		requestId,
		nodeHash,
		ownerEntityHash,
		logicalPath,
	}
	await fanoutFedFetch(username, 'fed_manifest_get', payload)
	const result = await done
	if (!result) return null

	await maybeCacheIncomingPublicManifest(ownerEntityHash, logicalPath, result)
	return result
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
