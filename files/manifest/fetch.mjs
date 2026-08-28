import { parseEntityHash } from '../../core/entity_id.mjs'
import { assertSafeEvfsLogicalPath } from '../../core/evfs_logical_path.mjs'
import { isWritableLocalEntity } from '../../node/identity.mjs'
import { getEntityStore } from '../../node/instance.mjs'
import { ms } from '../../utils/duration.mjs'
import { createInflightTable } from '../../utils/inflight_table.mjs'
import { loadFileManifest, saveFileManifest } from '../evfs.mjs'
import { beginFedFanoutFetch } from '../fed/fetch_shared.mjs'
import { canonicalizeFanoutTargets } from '../fetch_fanout.mjs'

import { resolveManifestAclType } from './acl_registry.mjs'
import { normalizeFileManifest } from './normalize.mjs'
import {
	manifestFetchExpectedKey,
	MAX_PENDING_MANIFEST_FETCHES,
	registerManifestFetchWait,
} from './pending.mjs'
import { shouldPreferIncomingPublicManifest } from './public.mjs'
import { getManifestServicer } from './servicer_registry.mjs'

const DEFAULT_MANIFEST_FETCH_TIMEOUT_MS = ms('8s')

/** 同 username+owner+path+模式 共享一次 fanout；队满只丢已超基础超时的队首。 */
const manifestInflight = createInflightTable({
	maxSize: MAX_PENDING_MANIFEST_FETCHES,
	baseTimeoutMs: DEFAULT_MANIFEST_FETCH_TIMEOUT_MS,
})

/**
 * 拉取 manifest。默认走 node-scope public 语义（仅接受验签公开 manifest）；
 * 传入 `fanoutTargets` 时只向目标集 fanout，并接受无签名的非 public manifest（信任边界 = 目标集 + 服务端 servicer）。
 * 非 public 命中默认写盘；public 按 `cache: true` 择新写盘。
 * 本地已验签公开缓存立即返回（`cache: true` 时后台 fanout 刷新）；非 public / 未验签 public 本地命中仅 targeted 模式返回，
 * public 模式拒绝。同 key（含规范化目标集）in-flight 去重；调用方外层超时不 abort，后台继续填缓存。
 * @param {{ username: string, ownerEntityHash: string, logicalPath: string, fanoutTargets?: string[], cache?: boolean, timeoutMs?: number }} context - 拉取上下文
 * @returns {Promise<import('./normalize.mjs').FileManifest | null>} 校验后的 manifest，失败为 null
 */
export async function fetchManifest(context) {
	const { ownerEntityHash, username } = context
	const logicalPath = context.logicalPath.replace(/^\/+/, '')
	if (!ownerEntityHash || !logicalPath || !username) return null

	const timeoutMs = Number(context.timeoutMs) > 0
		? Number(context.timeoutMs)
		: DEFAULT_MANIFEST_FETCH_TIMEOUT_MS
	const expectedKey = manifestFetchExpectedKey(ownerEntityHash, logicalPath)
	const wantCache = context.cache === true
	const targeted = Array.isArray(context.fanoutTargets)
	const fanoutTargets = targeted ? canonicalizeFanoutTargets(context.fanoutTargets) : undefined

	// 先同步挂 in-flight，再读本地 — 避免并发调用在 await 间隙各自 start（本地慢读可能晚于对端结算）。
	const localPromise = loadFileManifest(ownerEntityHash, logicalPath)
	const shared = beginFedFanoutFetch({
		inflight: manifestInflight,
		inflightKey: `${username}\0${expectedKey}\0${targeted ? 'targeted' : 'public'}` + (fanoutTargets?.length ? `\0${fanoutTargets.join('\0')}` : ''),
		username,
		action: 'fed_manifest_get',
		/**
		 * @param {string} requestId 请求 id
		 * @returns {{ done: Promise<import('./normalize.mjs').FileManifest | null>, cancel: () => void }} 等待句柄
		 */
		registerWait: requestId => registerManifestFetchWait(
			requestId,
			expectedKey,
			timeoutMs,
			targeted ? { allowNonPublic: true, targetNodeHashes: fanoutTargets } : undefined,
		),
		/**
		 * @param {string} requestId 请求 id
		 * @returns {object} fanout 载荷
		 */
		buildPayload: requestId => ({
			requestId,
			ownerEntityHash,
			logicalPath,
		}),
		fanoutTargets,
	})
	const local = await localPromise

	// 本地已验签公开命中：立即返回；cache: true 时后台 fanout 择新刷新。
	const isLocalPublic = local?.transferKeyDescriptor?.type === 'public' && !!local?.meta?.publicSig
	if (isLocalPublic) {
		if (wantCache && shared) void shared.then(async result => {
			if (result && shouldPreferIncomingPublicManifest(local, result))
				await cachePublicManifest(ownerEntityHash, logicalPath, result)
		})
		return local
	}

	// 本地非 public / 未验签 public 命中：仅 targeted 模式返回（授权边界 = 目标集）；public 模式拒绝。
	if (local) return targeted ? local : null

	if (!shared) return null

	const result = await shared
	if (!result) return null
	if (wantCache || targeted)
		if (result.transferKeyDescriptor.type === 'public')
			await cachePublicManifest(ownerEntityHash, logicalPath, result)
		else if (!isWritableLocalEntity(ownerEntityHash))
			await saveFileManifest(result)

	return result
}

/**
 * 将已验签公开 manifest 写入本地缓存（显式 apply；`fetchManifest` public 模式默认不调用）。
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
 * 响应 fed_manifest_get：public 只回验签公开清单；非 public 经 ACL servicer 授权后回完整清单。
 * @param {object} payload 请求
 * @param {(response: object, peerId: string) => void} sendResponse 发送
 * @param {string} peerId 对端（传输层认证的发送方 nodeHash，即 requesterNodeHash）
 * @returns {Promise<void>}
 */
export async function handleIncomingManifestGet(payload, sendResponse, peerId) {
	const parsedOwner = parseEntityHash(payload?.ownerEntityHash)
	if (!parsedOwner) return
	let logicalPath
	try {
		logicalPath = assertSafeEvfsLogicalPath(payload?.logicalPath)
	}
	catch { return }
	const requestId = String(payload?.requestId || '')
	if (!requestId) return
	const { entityHash: ownerEntityHash } = parsedOwner

	const raw = await getEntityStore().readManifest(ownerEntityHash, logicalPath)
	const manifest = normalizeFileManifest(raw)
	if (!manifest) return

	if (manifest.transferKeyDescriptor.type === 'public') {
		if (!raw?.meta?.publicSig) return
		sendResponse({
			requestId,
			manifest: {
				...manifest,
				meta: { publicSig: raw.meta.publicSig },
			},
		}, peerId)
		return
	}

	// 非 public：ACL servicer 授权后回完整 manifest（读侧解密依赖 meta.dagParts / groupId）。
	const aclType = resolveManifestAclType(manifest, ownerEntityHash) || manifest.transferKeyDescriptor.type
	const servicer = getManifestServicer(aclType)
	if (!servicer) return
	const allowed = await servicer({
		manifest,
		ownerEntityHash,
		logicalPath,
		requesterNodeHash: peerId,
		peerId,
		payload,
	})
	if (!allowed) return
	sendResponse({ requestId, manifest }, peerId)
}
