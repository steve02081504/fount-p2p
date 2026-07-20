/**
 * Entity 密钥历史链：entityHash 锚定 recovery 公钥，活跃钥可轮换。
 */
import { Buffer } from 'node:buffer'

import { canonicalStringify } from '../core/canonical_json.mjs'
import { hashFromPubKeyHex } from '../core/entity_id.mjs'
import { isHex64, normalizeHex64 } from '../core/hexIds.mjs'

/**
 *
 */
export const ENTITY_KEY_REVOKE_DOMAIN = 'fount-entity-key-revoke'

/**
 * @typedef {{
 *   generation: number,
 *   activePubKeyHex: string,
 *   attestedBy: 'recovery' | 'active' | 'revoked',
 *   validFrom?: number,
 *   revokedGenerations?: number[],
 * }} EntityKeyHistoryEntry
 */

/**
 * @param {unknown} recoveryPubKeyHex 64 位十六进制 recovery 公钥
 * @returns {string} 稳定 subjectHash（entityHash 后半）
 */
export function recoverySubjectHashFromPubKeyHex(recoveryPubKeyHex) {
	return hashFromPubKeyHex(recoveryPubKeyHex)
}

/**
 * @param {unknown} activePubKeyHex 64 位十六进制 活跃公钥
 * @returns {string} 时间线 sender（pubKeyHash）
 */
export function activeSenderHashFromPubKeyHex(activePubKeyHex) {
	return hashFromPubKeyHex(activePubKeyHex)
}

/**
 * @param {string} recoveryPubKeyHex recovery 公钥
 * @param {string} activePubKeyHex 初始活跃公钥
 * @param {number} [validFrom] 生效时间
 * @returns {EntityKeyHistoryEntry[]} 创世链
 */
export function createGenesisKeyHistory(recoveryPubKeyHex, activePubKeyHex, validFrom = Date.now()) {
	return [{
		generation: 0,
		activePubKeyHex: normalizeHex64(activePubKeyHex),
		attestedBy: 'recovery',
		validFrom,
	}]
}

/**
 * @param {EntityKeyHistoryEntry[]} keyHistory 密钥历史
 * @param {number} generation 代际
 * @returns {string | null} 活跃公钥 hex
 */
export function resolveActiveKeyAtGeneration(keyHistory, generation) {
	const entry = keyHistory.find(row => row.generation === generation)
	return entry?.activePubKeyHex ?? null
}

/**
 * @param {EntityKeyHistoryEntry[]} keyHistory 密钥历史
 * @param {number} generation 代际
 * @returns {boolean} 是否已吊销
 */
export function isActiveGenerationRevoked(keyHistory, generation) {
	for (const entry of keyHistory)
		if (entry.revokedGenerations?.includes(generation)) return true
	return false
}

/**
 * @param {EntityKeyHistoryEntry[]} keyHistory 密钥历史
 * @param {string} recoveryPubKeyHex recovery 公钥
 * @param {string} senderPubKeyHash 事件 sender（64 hex pubKeyHash）
 * @returns {boolean} sender 是否为未吊销的活跃钥
 */
export function isValidActiveSender(keyHistory, recoveryPubKeyHex, senderPubKeyHash) {
	const sender = normalizeHex64(senderPubKeyHash)
	if (!isHex64(sender)) return false
	void recoveryPubKeyHex
	for (const entry of keyHistory || []) {
		if (isActiveGenerationRevoked(keyHistory, entry.generation)) continue
		if (activeSenderHashFromPubKeyHex(entry.activePubKeyHex) === sender)
			return true
	}
	return false
}

/**
 * @param {string} recoveryPubKeyHex recovery 公钥
 * @param {string} senderPubKeyHash 事件 sender
 * @returns {boolean} 是否为 recovery 钥签名
 */
export function isRecoverySender(recoveryPubKeyHex, senderPubKeyHash) {
	return recoverySubjectHashFromPubKeyHex(recoveryPubKeyHex) === normalizeHex64(senderPubKeyHash)
}

/**
 * @param {object} state 物化状态
 * @param {object} event entity_key_rotate 事件
 * @returns {object} 更新后状态
 */
export function reduceEntityKeyRotate(state, event) {
	const generation = Number(event.content?.generation)
	const activePubKeyHex = normalizeHex64(event.content?.activePubKeyHex || '')
	if (!Number.isFinite(generation) || generation < 0 || !isHex64(activePubKeyHex))
		return state
	state.entityKeyHistory = state.entityKeyHistory || []
	if (state.entityKeyHistory.some(row => row.generation === generation))
		return state
	state.entityKeyHistory.push({
		generation,
		activePubKeyHex,
		attestedBy: generation === 0 ? 'recovery' : 'active',
		validFrom: event.hlc?.wall ?? event.timestamp,
	})
	return state
}

/**
 * @param {object} state 物化状态
 * @param {object} event entity_key_revoke 事件
 * @returns {object} 更新后状态
 */
export function reduceEntityKeyRevoke(state, event) {
	const newGeneration = Number(event.content?.newGeneration)
	const activePubKeyHex = normalizeHex64(event.content?.activePubKeyHex || '')
	const revokeGenerations = (event.content?.revokeGenerations || [])
		.map(Number).filter(Number.isFinite)
	if (!Number.isFinite(newGeneration) || newGeneration < 0 || !isHex64(activePubKeyHex))
		return state
	state.entityKeyHistory = state.entityKeyHistory || []
	for (const gen of revokeGenerations) {
		const entry = state.entityKeyHistory.find(row => row.generation === gen)
		if (entry) {
			entry.revokedGenerations = entry.revokedGenerations || []
			if (!entry.revokedGenerations.includes(gen))
				entry.revokedGenerations.push(gen)
		}
	}
	if (!state.entityKeyHistory.some(row => row.generation === newGeneration))
		state.entityKeyHistory.push({
			generation: newGeneration,
			activePubKeyHex,
			attestedBy: 'recovery',
			validFrom: event.hlc?.wall ?? event.timestamp,
		})

	return state
}
/**
 * @param {object[]} events 时间线事件（拓扑序）
 * @returns {{ recoveryPubKeyHex: string | null, entityKeyHistory: EntityKeyHistoryEntry[] }} 折叠密钥链
 */
export function foldEntityKeyHistoryFromEvents(events) {
	/** @type {EntityKeyHistoryEntry[]} */
	let entityKeyHistory = []
	for (const event of events || []) {
		if (event.type === 'entity_key_rotate') {
			const state = reduceEntityKeyRotate({ entityKeyHistory }, event)
			entityKeyHistory = state.entityKeyHistory
		}
		if (event.type === 'entity_key_revoke') {
			const state = reduceEntityKeyRevoke({ entityKeyHistory }, event)
			entityKeyHistory = state.entityKeyHistory
		}
	}
	return { recoveryPubKeyHex: null, entityKeyHistory }
}

/**
 * @param {object} revokeBody 吊销正文
 * @returns {Buffer} 固定域签名消息
 */
export function entityKeyRevokeSignBytes(revokeBody) {
	const body = {
		revokeGenerations: (revokeBody.revokeGenerations || []).map(Number),
		newGeneration: Number(revokeBody.newGeneration),
		activePubKeyHex: normalizeHex64(revokeBody.activePubKeyHex || ''),
		entityHash: String(revokeBody.entityHash || '').trim().toLowerCase(),
	}
	return Buffer.from(`${ENTITY_KEY_REVOKE_DOMAIN}\0${canonicalStringify(body)}`, 'utf8')
}
