/**
 * census 包验签（Untrusted ingress；Node 与浏览器共用，无 Node 依赖）。
 *
 * 签名体：{ nodeHash, nodePubKey, ts, p, sig }，消息 `fount-census\0ts\0nodeHash\0p`，
 * 用节点身份（Ed25519）签名，nodeHash = sha256(nodePubKey)。
 */
import { hexToBytes } from '../../core/bytes_codec.mjs'
import { isHex64, isSignatureHex128 } from '../../core/hexIds.mjs'
import { pubKeyHash, verify } from '../../crypto/crypto.mjs'

import { CENSUS_MIN_P } from './census_math.mjs'

/** 事件/窗口存活时间（与 advert TTL 一致）。 */
export const CENSUS_TTL_MS = 10 * 60_000

/**
 * @param {number} ts 时间戳（毫秒）
 * @param {string} nodeHash 64 hex 节点 hash
 * @param {number} p 包含概率
 * @returns {Uint8Array} 待签名消息
 */
export function buildCensusMessage(ts, nodeHash, p) {
	return new TextEncoder().encode(`fount-census\0${ts}\0${nodeHash}\0${p}`)
}

/**
 * 校验 census 包（Untrusted ingress）：canonicalize + 验签 + 时间窗 + p 范围。
 * @param {unknown} packet 原始 census 包
 * @param {number} [now=Date.now()] 当前时间（毫秒）
 * @param {number} [ttlMs=CENSUS_TTL_MS] 允许的时间窗
 * @returns {Promise<{ nodeHash: string, p: number, ts: number } | null>} 校验通过返回 nodeHash/p/ts，否则 null
 */
export async function verifyCensusPacket(packet, now = Date.now(), ttlMs = CENSUS_TTL_MS) {
	const nodeHash = isHex64(packet?.nodeHash)
	const nodePubKey = isHex64(packet?.nodePubKey)
	const sig = isSignatureHex128(packet?.sig)
	const ts = Number(packet?.ts)
	const p = Number(packet?.p)
	if (!nodeHash || !nodePubKey || !sig || !Number.isFinite(ts)) return null
	if (Math.abs(now - ts) > ttlMs) return null
	if (!Number.isFinite(p) || p < CENSUS_MIN_P || p > 1) return null
	try {
		if (pubKeyHash(hexToBytes(nodePubKey)) !== nodeHash) return null
	}
	catch {
		return null
	}
	return await verify(hexToBytes(sig), buildCensusMessage(ts, nodeHash, p), hexToBytes(nodePubKey)) ? { nodeHash, p, ts } : null
}

/**
 * 解 base64 content 字节并校验 census 包。
 * @param {Uint8Array} bytes content 解码字节
 * @param {number} [now=Date.now()] 当前时间（毫秒）
 * @param {number} [ttlMs=CENSUS_TTL_MS] 允许的时间窗
 * @returns {Promise<{ nodeHash: string, p: number, ts: number } | null>} 校验通过结果或 null
 */
export async function verifyCensusBytes(bytes, now = Date.now(), ttlMs = CENSUS_TTL_MS) {
	try {
		return await verifyCensusPacket(JSON.parse(new TextDecoder().decode(bytes)), now, ttlMs)
	}
	catch {
		return null
	}
}
