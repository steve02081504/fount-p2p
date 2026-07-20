import { Buffer } from 'node:buffer'

import { normalizeHex64 } from '../../core/hexIds.mjs'
import { createLinkPipe } from '../pipe.mjs'

/**
 * 构造 link-open control JSON。
 * @param {string} linkId 链路 id（64 hex）
 * @param {string} [fromNodeHash] 本端 nodeHash
 * @returns {string} JSON 文本
 */
export function buildLinkOpen(linkId, fromNodeHash = '') {
	return JSON.stringify({ type: 'link-open', linkId, from: fromNodeHash || '' })
}

/**
 * 解析 link-open；非法返回 null。
 * @param {string | Uint8Array | Buffer} raw 原始 control
 * @returns {{ linkId: string, from: string | null } | null} 解析结果
 */
export function parseLinkOpen(raw) {
	let parsed
	try {
		parsed = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'))
	}
	catch { return null }
	if (parsed?.type !== 'link-open' || !parsed.linkId) return null
	return { linkId: String(parsed.linkId), from: normalizeHex64(parsed.from) || null }
}

/**
 * 以固定 linkId 作为 hello/auth binding 的 pipe。
 * @param {Parameters<typeof createLinkPipe>[0] & { linkId: string }} options pipe 配置（须含 linkId）
 * @returns {ReturnType<typeof createLinkPipe>} link pipe
 */
export function createLinkIdBoundPipe(options) {
	const linkId = normalizeHex64(options.linkId)
	if (!linkId) throw new Error(`p2p: ${options.providerId || 'link'} linkId required`)
	return createLinkPipe({
		...options,
		/** @returns {string} 本地 binding */
		getLocalBinding: () => linkId,
		/** @returns {string} 远端 binding */
		getRemoteBinding: () => linkId,
	})
}
