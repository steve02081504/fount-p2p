import { Buffer } from 'node:buffer'

import { canonicalStringify } from '../core/canonical_json.mjs'
import { merkleRoot } from '../dag/index.mjs'

import { sign, verify } from './crypto.mjs'

/**
 * 为 checkpoint 载荷附加签名（签名字段不包含 `checkpoint_signature` 自身）。
 * @param {object} payload 待签名载荷
 * @param {Uint8Array} secretKey 32 字节种子私钥
 * @returns {Promise<object>} 带 `checkpoint_signature` 的载荷
 */
export async function signCheckpoint(payload, secretKey) {
	const body = { ...payload }
	delete body.checkpoint_signature
	const messageBytes = Buffer.from(canonicalStringify(body), 'utf8')
	const signature = await sign(messageBytes, secretKey)
	return { ...payload, checkpoint_signature: Buffer.from(signature).toString('hex') }
}

/**
 * 校验 `checkpoint_signature` 与载荷的一致性。
 * @param {object} checkpoint 完整检查点对象
 * @param {Uint8Array} ownerPublicKey 32 字节公钥
 * @returns {Promise<boolean>} 合法为 true
 */
export async function verifyCheckpointSignature(checkpoint, ownerPublicKey) {
	const raw = checkpoint.checkpoint_signature.trim()
	if (!/^[\da-f]{128}$/iu.test(raw)) return false
	const body = { ...checkpoint }
	delete body.checkpoint_signature
	const messageBytes = Buffer.from(canonicalStringify(body), 'utf8')
	return verify(Buffer.from(raw, 'hex'), messageBytes, ownerPublicKey)
}

/**
 * 判断 checkpoint 是否带合法 Ed25519 签名。
 * @param {object | null | undefined} checkpoint checkpoint 对象
 * @returns {boolean} 签名格式合法为 true
 */
export function isSignedCheckpoint(checkpoint) {
	return /^[\da-f]{128}$/iu.test(String(checkpoint?.checkpoint_signature || '').trim())
}

/**
 * 校验远端 checkpoint 的结构、Merkle 根与 delegated owner 签名。
 * @param {object | null | undefined} checkpoint checkpoint 对象
 * @returns {Promise<{ valid: boolean, reason?: string }>} 校验结果；`valid` 为 false 时 `reason` 说明原因
 */
export async function verifyRemoteCheckpoint(checkpoint) {
	if (!checkpoint || typeof checkpoint !== 'object')
		return { valid: false, reason: 'checkpoint missing or not an object' }
	if (!Array.isArray(checkpoint.eventIdsInEpoch) || checkpoint.eventIdsInEpoch.length === 0)
		return { valid: false, reason: 'eventIdsInEpoch missing or empty' }
	const root = merkleRoot(checkpoint.eventIdsInEpoch)
	if (checkpoint.epoch_root_hash !== root)
		return { valid: false, reason: 'epoch_root_hash does not match Merkle root of eventIdsInEpoch' }
	const ownerHash = checkpoint.members_record?.delegatedOwnerPubKeyHash
	const owner = checkpoint.members_record?.members?.[ownerHash]
	const pubHex = owner?.pubKeyHex
	if (!pubHex || !/^[\da-f]{64}$/iu.test(pubHex))
		return { valid: false, reason: 'delegated owner pubkey missing' }
	if (!await verifyCheckpointSignature(checkpoint, Buffer.from(pubHex, 'hex')))
		return { valid: false, reason: 'checkpoint signature invalid' }
	return { valid: true }
}
